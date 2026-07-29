import { createHash } from "node:crypto";
import { RawCandidate } from "@leadops/core";
import { buildDedupeKey, buildGroupKey, canonicalSido, normalizeBizNo, normalizeCompanyName, normalizeCorpNo, normalizePhone } from "../normalize";
import { countSkip, emptyResult, type StageContext, type StageHandler, type StageResult } from "./types";

/**
 * 스테이지 2 — 정규화와 중복 제거.
 *
 * `raw_candidates` 를 읽어 `companies` 로 승격시킨다.
 * 같은 `dedupe_key` 를 가진 후보는 하나의 company 로 합쳐진다.
 *
 * 멱등: `on conflict (dedupe_key) do update` + 처리 표시를 같은 트랜잭션에 넣는다.
 */

/**
 * 변경 탐지용 지문 (설계서 결론 D).
 *
 * 재평가는 주기가 아니라 **변경**이 촉발한다. 이 지문이 바뀌면 다시 볼 가치가 있다.
 * 이름·주소·전화·홈페이지·규모만 넣는다 — 좌표나 수집 시각처럼 매번 흔들리는 값은 뺀다.
 */
export function contentFingerprint(c: RawCandidate): string {
  const parts = [
    normalizeCompanyName(c.name),
    (c.address ?? "").replace(/\s+/g, ""),
    normalizePhone(c.phone) ?? "",
    (c.homepageUrl ?? "").trim().toLowerCase(),
    JSON.stringify(Object.entries(c.sizeSignals).sort()),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

interface PendingRow {
  id: string;
  payload: unknown;
}

export const normalizeStage: StageHandler = {
  stage: "normalize",
  dependsOn: ["collect"],

  async run(ctx: StageContext): Promise<StageResult> {
    const result = emptyResult();
    const BATCH = 200;

    for (;;) {
      const pending = await ctx.sql<PendingRow[]>`
        select id, payload from raw_candidates
        where attempt_id = ${ctx.attemptId} and normalized_at is null
        order by id
        limit ${BATCH}
      `;
      if (pending.length === 0) break;

      for (const row of pending) {
        result.processed++;
        const parsed = RawCandidate.safeParse(row.payload);
        if (!parsed.success) {
          countSkip(result, "invalid_payload");
          await ctx.sql`
            update raw_candidates
            set normalized_at = now(), skip_reason = 'invalid_payload'
            where id = ${row.id}
          `;
          continue;
        }

        const c = parsed.data;
        const dedupe = buildDedupeKey(c);
        const group = buildGroupKey(c);
        const fingerprint = contentFingerprint(c);

        // 그룹과 회사를 한 트랜잭션에서 처리해야 부분 반영이 남지 않는다.
        const companyId = await ctx.sql.begin(async (tx) => {
          let groupId: string | null = null;
          if (group) {
            const [g] = await tx<{ id: string }[]>`
              insert into company_groups (group_key, kind, display_name)
              values (${group.key}, ${group.kind}, ${group.displayName})
              on conflict (group_key) do update set display_name = excluded.display_name
              returning id
            `;
            groupId = g!.id;
          }

          // ❗ 변경 탐지는 upsert **전에** 읽어야 한다.
          //    RETURNING 안의 서브쿼리는 스냅샷 시점이 모호하고, `xmax = 0` 은
          //    구현 세부에 기대는 트릭이라 둘 다 신뢰하지 않는다.
          const [existing] = await tx<{ content_fingerprint: string | null }[]>`
            select content_fingerprint from companies where dedupe_key = ${dedupe.key}
          `;
          const created = existing === undefined;
          const changed = !created && existing.content_fingerprint !== fingerprint;

          const [company] = await tx<{ id: string }[]>`
            insert into companies (
              dedupe_key, name, normalized_name, industry, biz_no, corp_no,
              region_sido, region_sigungu, region_dong, address, phone, lat, lng,
              status, status_source, size_signals, group_id, content_fingerprint,
              last_scanned_at, scan_count
            )
            values (
              ${dedupe.key}, ${c.name}, ${normalizeCompanyName(c.name)}, ${c.industry},
              ${normalizeBizNo(c.bizNo) ?? null}, ${normalizeCorpNo(c.corpNo) ?? null},
              ${canonicalSido(c.regionSido) ?? null}, ${c.regionSigungu ?? null}, ${c.regionDong ?? null},
              ${c.address ?? null}, ${normalizePhone(c.phone) ?? null},
              ${c.lat ?? null}, ${c.lng ?? null},
              ${c.status}, ${c.source}, ${tx.json(c.sizeSignals)}, ${groupId},
              ${fingerprint}, now(), 1
            )
            on conflict (dedupe_key) do update set
              name = excluded.name,
              normalized_name = excluded.normalized_name,
              -- 기존 값이 있으면 유지한다. 소스마다 채워 주는 필드가 다르기 때문이다.
              biz_no = coalesce(companies.biz_no, excluded.biz_no),
              corp_no = coalesce(companies.corp_no, excluded.corp_no),
              region_sido = coalesce(excluded.region_sido, companies.region_sido),
              region_sigungu = coalesce(excluded.region_sigungu, companies.region_sigungu),
              address = coalesce(excluded.address, companies.address),
              phone = coalesce(excluded.phone, companies.phone),
              status = excluded.status,
              status_source = excluded.status_source,
              size_signals = excluded.size_signals,
              group_id = coalesce(excluded.group_id, companies.group_id),
              content_fingerprint = excluded.content_fingerprint,
              last_scanned_at = now(),
              scan_count = companies.scan_count + 1,
              updated_at = now()
            returning id
          `;

          const track = created ? "new" : changed ? "changed" : "unchanged";

          await tx`
            insert into company_observations (
              company_id, attempt_id, status, content_fingerprint, change_detected, track, summary
            )
            values (
              ${company!.id}, ${ctx.attemptId}, ${c.status}, ${fingerprint},
              ${changed}, ${track},
              ${tx.json({ source: c.source, externalId: c.externalId, dedupeBasis: dedupe.basis, dedupeConfidence: dedupe.confidence })}
            )
            on conflict (company_id, attempt_id) do update set
              status = excluded.status,
              content_fingerprint = excluded.content_fingerprint,
              change_detected = excluded.change_detected,
              track = excluded.track,
              summary = excluded.summary
          `;

          // 홈페이지 URL 이 오면 websites 에 심어 둔다 (HIRA 는 hospUrl 을 준다).
          if (c.homepageUrl) {
            const canonical = canonicalizeUrl(c.homepageUrl);
            if (canonical) {
              await tx`
                insert into websites (company_id, canonical_url, domain)
                values (${company!.id}, ${canonical.url}, ${canonical.domain})
                on conflict (company_id, canonical_url) do nothing
              `;
            }
          }

          await tx`
            update raw_candidates set normalized_at = now(), company_id = ${company!.id}
            where id = ${row.id}
          `;
          return company!.id;
        });

        if (companyId) result.passed++;
      }
    }

    const [summary] = await ctx.sql<{ companies: string }[]>`
      select count(distinct company_id)::text as companies
      from raw_candidates where attempt_id = ${ctx.attemptId} and company_id is not null
    `;
    result.note = `원본 ${result.processed}건 → 업체 ${summary?.companies ?? "?"}개 (중복 제거 후)`;
    return result;
  },
};

/** URL 정규화. scheme·host 소문자, www 제거, 후행 슬래시 제거. */
export function canonicalizeUrl(raw: string): { url: string; domain: string } | undefined {
  let candidate = raw.trim();
  if (candidate.length === 0) return undefined;
  if (!/^https?:\/\//i.test(candidate)) candidate = `http://${candidate}`;

  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const domain = u.hostname.toLowerCase().replace(/^www\./, "");
    if (domain.length === 0 || !domain.includes(".")) return undefined;
    const path = u.pathname.replace(/\/+$/, "");
    return { url: `${u.protocol}//${domain}${path}`, domain };
  } catch {
    return undefined;
  }
}
