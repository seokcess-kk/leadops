import type { SearchAdapter } from "@leadops/adapters";
import {
  discoverHomepage,
  discoverHomepageFromWebSearch,
  discoveryQuery,
  type DiscoveryRejection,
  type KnownCompany,
  type LocalCandidate,
  type WebCandidate,
} from "../homepageDiscovery";
import { QuotaGuard, quotaSettingsFrom } from "../quota";
import { countSkip, emptyResult, type StageContext, type StageHandler, type StageResult } from "./types";

/**
 * 스테이지 3.5 — 홈페이지 발견 (설계서 3.2 · M1 소스 보강).
 *
 * 평가 가능한 후보가 없는 업체 — `hospUrl` 이 없거나, 있는 후보가 전부 최신 관측
 * `unavailable`(NXDOMAIN·robots 차단) — 에 대해 **지역검색으로 후보 URL 을 찾아
 * `websites` 에 넣는다.** 판정은 하지 않는다 — 다음 스테이지(`homepage_detect`)의
 * 다신호 판정이 그대로 결정한다.
 *
 * ## 왜 필요한가
 *
 * 실측 (2026-07-30 · 표본 900건): HIRA 의 `hospUrl` 은 **20.8%** 만 채워져 있다. 나머지는
 * 평가할 URL 자체가 없어 `no_homepage_url` 로 스킵되고, 그 뒤 단계가 전부 그 위에서만
 * 돈다 (표본 90건 기준: URL 17 → 공식 판정 3 → 검수 후보 0). M1 기준 ≥70% 는 소스
 * 보강 없이 넘을 수 없다.
 *
 * ## 안전장치
 *
 * ❗ **검색 결과를 그대로 믿지 않는다.** 전화번호 일치, 또는 상호+시군구 동시 일치가 있어야
 *    후보로 삼는다 (`homepageDiscovery.ts`). 근거 없이는 채택하지 않는다 — 엉뚱한 사이트를
 *    그 업체 것으로 저장하면 점수·취약점·추천이 전부 다른 업체 기준으로 계산되고,
 *    검수자는 그 사실을 알 방법이 없다.
 *
 * ❗ **어댑터가 없으면 실패가 아니라 건너뛴다.** `search_analyze` 와 같은 규칙이다 —
 *    ORS 없는 축소 파이프라인이 1급 경로이고, 발견도 마찬가지로 선택 기능이다.
 *
 * ❗ **쿼터는 호출 전에 선점한다.** 한도에 닿으면 그 자리에서 멈춘다. 네이버 쿼터는
 *    ORS 와 **합산**(일 25,000회)이므로 같은 provider 원장을 쓴다.
 *
 * ❗ 이 스테이지는 `websites` 를 **넣기만** 한다. `official_status` 를 쓰지 않는다 —
 *    발견과 판정을 한 곳에서 하면 "검색이 찾았으니 공식" 이 되어 다신호 판정이 무력해진다.
 *
 * 지역검색이 근거를 못 찾으면 웹검색(webkr)으로 1회 폴백한다 — 텍스트 근거(상호 접미
 * 완화 + 시군구 동시 포함).
 */

/** 업체당 지역검색 호출 수. 상호+시군구 질의 하나면 충분하다 (display 상한이 5다). */
const CALLS_PER_COMPANY = 1;

/** 지역검색 결과 상한. `MAX_DISPLAY.local` 이 5 이므로 그 이상은 의미가 없다. */
const DISPLAY = 5;

/** 웹검색 폴백 결과 상한. 텍스트 근거 필터라 상위권만 의미가 있다. */
const WEB_DISPLAY = 10;

const BATCH = 100;

interface Target {
  company_id: string;
  name: string;
  phone: string | null;
  address: string | null;
  region_sigungu: string | null;
}

/** 지역검색 히트를 판별 입력으로 옮긴다. */
function toCandidates(hits: readonly {
  title: string;
  link: string;
  telephone?: string | undefined;
  address?: string | undefined;
  roadAddress?: string | undefined;
}[]): LocalCandidate[] {
  return hits.map((h) => ({
    title: h.title,
    link: h.link,
    ...(h.telephone === undefined ? {} : { telephone: h.telephone }),
    ...(h.address === undefined ? {} : { address: h.address }),
    ...(h.roadAddress === undefined ? {} : { roadAddress: h.roadAddress }),
  }));
}

export const homepageDiscoverStage: StageHandler = {
  stage: "homepage_discover",
  dependsOn: ["exclude_basic"],

  async run(ctx: StageContext): Promise<StageResult> {
    const result = emptyResult();

    const adapter: SearchAdapter | undefined = ctx.search;
    if (!adapter) {
      // ❗ 실패가 아니다. 발견 없이도 `hospUrl` 이 있는 업체는 그대로 판정된다.
      result.note =
        "검색 어댑터 없음 — 홈페이지 발견을 건너뛴다 (M1 은 hospUrl 보유분으로만 산출된다)";
      result.skipped["discovery_disabled"] = 1;
      return result;
    }
    if (!adapter.verifiedAgainstLiveApi) {
      ctx.logger.warn("stage.discover.unverified_adapter", {
        source: adapter.sourceName,
        note: "이 어댑터는 실 API 로 검증되지 않았습니다. 발견된 URL 을 확정으로 다루지 마세요.",
      });
    }

    const quota = new QuotaGuard(ctx.sql, ctx.runId, {
      provider: adapter.sourceName,
      // ORS 와 **합산** 한도다. 같은 provider 원장을 쓰므로 자동으로 합쳐진다.
      dailyCap: quotaSettingsFrom(ctx.settings).naverDailyCap,
      unit: "call",
    });

    let exhausted = false;
    let found = 0;
    let offset = 0;

    for (;;) {
      if (exhausted) break;

      // ❗ **평가 가능한 후보가 없는** 업체만 본다. 두 경우다:
      //    (a) websites 행이 아예 없다 — 원래 대상
      //    (b) 모든 후보의 최신 관측이 unavailable 이다 — 낡은 hospUrl(NXDOMAIN·robots
      //        차단)만 있는 업체. "URL 이 있다" 는 이유로 건너뛰면 영원히 unavailable 에
      //        머문다 (골드셋 FN 실사례).
      //    아직 관측이 없는 후보가 있으면 제외한다 — 먼저 판정 기회를 준다. 살아있는
      //    관측(uncertain 포함)이 있어도 제외한다 — 검색 결과가 판정을 앞지르면 안 된다.
      //    기존 행은 어떤 경우에도 덮지 않는다. 후보를 **추가**할 뿐이다.
      const targets = await ctx.sql<Target[]>`
        select c.id as company_id, c.name, c.phone, c.address, c.region_sigungu
        from companies c
        join company_observations o on o.company_id = c.id and o.attempt_id = ${ctx.attemptId}
        where c.excluded_reason is null
          and not exists (
            select 1 from websites w
            where w.company_id = c.id
              and (
                not exists (select 1 from website_observations wo where wo.website_id = w.id)
                or (select wo.official_status from website_observations wo
                    where wo.website_id = w.id
                    order by wo.observed_at desc limit 1) <> 'unavailable'
              )
          )
        order by c.id
        limit ${BATCH} offset ${offset}
      `;
      if (targets.length === 0) break;
      // ❗ offset 으로 순회한다. 처리해도 조건이 바뀌지 않는 행(발견 실패)이 있어서,
      //    조건만으로 순회하면 같은 행을 무한히 다시 잡는다.
      offset += targets.length;

      for (const target of targets) {
        result.processed++;

        // ❗ 멱등 키에 attempt 와 업체를 함께 넣는다. 잡이 재시도돼도 같은 키라
        //    쿼터를 두 번 먹지 않는다 (`cost_ledger.entry_key` unique).
        const reserved = await quota.reserve(
          CALLS_PER_COMPANY,
          `discover:${ctx.attemptId}:${target.company_id}`,
        );
        if (!reserved.granted) {
          exhausted = true;
          countSkip(result, "quota_exhausted");
          ctx.logger.warn("stage.discover.quota_exhausted", {
            provider: quota.provider,
            used: reserved.used,
            cap: reserved.cap,
          });
          break;
        }

        const known: KnownCompany = {
          name: target.name,
          phone: target.phone,
          address: target.address,
          regionSigungu: target.region_sigungu,
        };

        let candidates: LocalCandidate[];
        try {
          const search = await adapter.search("local", discoveryQuery(known), DISPLAY);
          candidates = toCandidates(search.hits);
        } catch (err) {
          // ❗ 조회 실패를 "홈페이지 없음" 으로 기록하지 않는다. 그것은 우리 실패이지
          //    그 업체의 상태가 아니다 (설계서 A.6 과 같은 원칙).
          countSkip(result, "search_failed");
          ctx.logger.warn("stage.discover.search_failed", {
            companyId: target.company_id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        const discovery = discoverHomepage(known, candidates);
        let adopted =
          discovery.url === undefined ? undefined : { url: discovery.url, basis: discovery.basis ?? null };

        // ── webkr 폴백 ──
        // 조회는 됐으나 **근거가 없어** 채택에 실패한 경우에만 시도한다. 조회 에러는
        // 위의 catch 가 이미 search_failed 로 남기고 continue 했다 (설계 문서 B절).
        if (adopted === undefined) {
          const webReserved = await quota.reserve(
            CALLS_PER_COMPANY,
            `discover:webkr:${ctx.attemptId}:${target.company_id}`,
          );
          if (!webReserved.granted) {
            exhausted = true;
            countSkip(result, "quota_exhausted");
            ctx.logger.warn("stage.discover.quota_exhausted", {
              provider: quota.provider,
              used: webReserved.used,
              cap: webReserved.cap,
            });
            break;
          }
          try {
            const web = await adapter.search("webkr", discoveryQuery(known), WEB_DISPLAY);
            const webHits: WebCandidate[] = web.hits.map((h) => ({
              title: h.title,
              link: h.link,
              description: h.description,
            }));
            const webDiscovery = discoverHomepageFromWebSearch(known, webHits);
            if (webDiscovery.url !== undefined) {
              adopted = { url: webDiscovery.url, basis: webDiscovery.basis ?? null };
            } else {
              countSkip(result, `webkr_${webDiscovery.rejected ?? "no_text_evidence"}`);
            }
          } catch (err) {
            countSkip(result, "webkr_search_failed");
            ctx.logger.warn("stage.discover.webkr_failed", {
              companyId: target.company_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (adopted === undefined) {
          countSkip(result, discovery.rejected ?? ("no_matching_evidence" satisfies DiscoveryRejection));
          continue;
        }

        const host = new URL(adopted.url).hostname.toLowerCase().replace(/^www\./, "");
        // ❗ 멱등하다. 잡이 재시도돼도 같은 행이 두 번 생기지 않는다.
        await ctx.sql`
          insert into websites (company_id, canonical_url, domain,
                                discovery_source, discovery_basis, discovered_at)
          values (${target.company_id}, ${adopted.url}, ${host},
                  ${adapter.sourceName}, ${adopted.basis}, now())
          on conflict (company_id, domain) do nothing
        `;
        found++;
        result.passed++;
      }
    }

    result.note =
      `URL 없는 업체 ${result.processed}곳 조회 → ${found}곳에서 후보 확보` +
      (exhausted ? " (쿼터 소진으로 중단)" : "");
    return result;
  },
};
