import { createHash } from "node:crypto";
import { discoverChannels, type DiscoveredChannel } from "../channels";
import { detectContactPages, type ContactCandidate } from "../contactPages";
import { scanHtml } from "../html";
import { judgeOfficial, unavailableVerdict, type OfficialVerdict } from "../official";
import {
  countSkip,
  emptyResult,
  requireFetching,
  type FetchingStageContext,
  type StageContext,
  type StageHandler,
  type StageResult,
} from "./types";

/**
 * 스테이지 4 — 공식 홈페이지 판별 (설계서 5.3 스테이지 5).
 *
 * 업체마다 홈페이지를 **한 번** 가져와서 두 가지를 동시에 얻는다:
 *   1. 공식 홈페이지 판정 (`website_observations`)
 *   2. 연락처 페이지 URL 후보 (`contact_pages`)
 *
 * ❗ 설계서 DAG 는 이 둘을 스테이지 5·6 으로 나눠 두었지만, 후보 탐지는 **같은 HTML 의
 *    링크만** 보면 되므로 여기서 함께 처리한다. 따로 돌면 대상 사이트에 같은 요청을
 *    두 번 보내게 되고, 우리가 얻는 정보는 한 글자도 늘지 않는다. 스테이지 6
 *    (`contact_pages`)은 남아서 **게이트와 집계**를 맡는다 — 판정이 confirmed·likely 가
 *    아닌 사이트의 후보를 걷어내고 커버리지를 센다.
 *
 * ❗ 후보 페이지의 **본문은 절대 가져오지 않는다** (정보통신망법 제50조의2 · 결론 A).
 *    이 스테이지가 여는 URL 은 홈페이지 하나뿐이다.
 *
 * 멱등: `website_observations` 의 `unique (website_id, attempt_id)` 로 이미 처리한
 * 사이트는 다음 조회에서 빠진다. 실패해도 반드시 관측을 남기므로 루프가 멈춘다.
 */

const HTML_CONTENT_TYPES = Object.freeze(["text/html", "application/xhtml+xml"]);

/** 동시 처리 수. 실제 속도 제한은 HttpClient 의 도메인별 간격·전역 동시성이 건다. */
const CONCURRENCY = 6;

const BATCH = 200;

/** 이보다 긴 Crawl-delay 는 지키는 대신 건너뛴다. 한 사이트가 실행 전체를 잡아먹지 않게. */
const MAX_CRAWL_DELAY_SEC = 30;

interface Target {
  website_id: string;
  canonical_url: string;
  domain: string;
  company_id: string;
  name: string;
  phone: string | null;
  region_sigungu: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 고정 개수의 병렬 소비자로 목록을 처리한다. */
async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const consumers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const item = items[cursor++];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(consumers);
}

export const homepageStage: StageHandler = {
  stage: "homepage_detect",
  // ❗ 발견이 끝난 뒤에 판정한다. 순서가 뒤바뀌면 발견된 URL 이 판정 없이 남는다.
  //    발견이 꺼져 있어도(`FEATURE_ORS=off`) 그 스테이지는 즉시 성공하므로 막히지 않는다.
  dependsOn: ["homepage_discover"],

  async run(ctx: StageContext): Promise<StageResult> {
    const fetching = requireFetching(ctx, "homepage_detect");
    const result = emptyResult();

    // 홈페이지 URL 자체가 없는 업체는 관측을 남길 website 행이 없다.
    // 조용히 사라지지 않도록 여기서 한 번 센다.
    const [none] = await ctx.sql<Array<{ n: string }>>`
      select count(*)::text as n
      from companies c
      join company_observations o on o.company_id = c.id and o.attempt_id = ${ctx.attemptId}
      where c.excluded_reason is null
        and not exists (select 1 from websites w where w.company_id = c.id)
    `;
    if (Number(none?.n ?? 0) > 0) result.skipped["no_homepage_url"] = Number(none!.n);

    for (;;) {
      const targets = await ctx.sql<Target[]>`
        select w.id as website_id, w.canonical_url, w.domain,
               c.id as company_id, c.name, c.phone, c.region_sigungu
        from websites w
        join companies c on c.id = w.company_id
        join company_observations o on o.company_id = c.id and o.attempt_id = ${ctx.attemptId}
        where c.excluded_reason is null
          and not exists (
            select 1 from website_observations wo
            where wo.website_id = w.id and wo.attempt_id = ${ctx.attemptId}
          )
        order by w.id
        limit ${BATCH}
      `;
      if (targets.length === 0) break;

      // 같은 도메인에 몇 개 업체가 묶여 있는지 (목록에 없는 애그리게이터 탐지).
      const domains = [...new Set(targets.map((t) => t.domain))];
      const counts = await ctx.sql<Array<{ domain: string; n: string }>>`
        select domain, count(distinct company_id)::text as n
        from websites where domain in ${ctx.sql(domains)}
        group by domain
      `;
      const sharedByDomain = new Map(counts.map((c) => [c.domain, Number(c.n)]));

      await pool(targets, CONCURRENCY, async (target) => {
        result.processed++;
        const outcome = await inspect(fetching, target, sharedByDomain.get(target.domain) ?? 1);

        if (outcome.verdict.status === "unavailable") {
          countSkip(result, String(outcome.verdict.signals["reason"] ?? "unavailable"));
        } else if (outcome.verdict.status === "not_official") {
          countSkip(result, `not_official:${String(outcome.verdict.signals["disqualified"] ?? "score")}`);
        } else if (outcome.verdict.status === "uncertain") {
          countSkip(result, "uncertain");
        } else {
          result.passed++;
        }

        await persist(fetching, target, outcome);
      });
    }

    result.note = `${result.processed}개 사이트 중 ${result.passed}개가 공식(confirmed·likely)으로 판정`;
    return result;
  },
};

interface Inspection {
  verdict: OfficialVerdict;
  candidates: readonly ContactCandidate[];
  /** 공식 채널 (블로그·유튜브·SNS·플레이스). 같은 HTML 의 링크에서 나온다. */
  channels: readonly DiscoveredChannel[];
  robotsAllowed: boolean | null;
  httpStatus: number | null;
  hasNoindex: boolean;
  contentHash: string | null;
  crawledPages: number;
}

/**
 * 사이트 하나를 조사한다. **던지지 않는다** — 실패도 관측 결과의 하나다.
 *
 * 실패를 예외로 흘리면 그 사이트는 관측이 남지 않아 다음 배치 조회에 다시 잡히고,
 * 스테이지가 무한 루프에 빠진다.
 */
async function inspect(
  ctx: FetchingStageContext,
  target: Target,
  sharedCompanyCount: number,
): Promise<Inspection> {
  const empty: Omit<Inspection, "verdict"> = {
    candidates: [],
    channels: [],
    robotsAllowed: null,
    httpStatus: null,
    hasNoindex: false,
    contentHash: null,
    crawledPages: 0,
  };

  let gate;
  try {
    gate = await ctx.robots.check(target.canonical_url);
  } catch (err) {
    ctx.logger.warn("homepage.robots_error", { websiteId: target.website_id, error: message(err) });
    return { ...empty, verdict: unavailableVerdict("robots_error", target.domain), robotsAllowed: false };
  }

  if (!gate.allowed) {
    return {
      ...empty,
      robotsAllowed: false,
      verdict: unavailableVerdict(
        gate.failure ? `robots_${gate.failure}` : "robots_disallowed",
        target.domain,
      ),
    };
  }

  if (gate.crawlDelaySec !== undefined) {
    if (gate.crawlDelaySec > MAX_CRAWL_DELAY_SEC) {
      return {
        ...empty,
        robotsAllowed: true,
        verdict: unavailableVerdict("crawl_delay_too_long", target.domain),
      };
    }
    // robots.txt 를 이미 한 번 받았으므로 다음 요청까지 간격을 지킨다.
    if (gate.crawlDelaySec > 0) await sleep(gate.crawlDelaySec * 1000);
  }

  try {
    const res = await ctx.http.get(target.canonical_url, { acceptContentTypes: HTML_CONTENT_TYPES });
    const scan = scanHtml(res.body);
    const candidates = detectContactPages(scan.links, res.finalUrl);
    // 채널도 같은 링크 목록에서 나온다 — 추가 요청 0회 (설계서 4.1 쿼터 절감).
    const channels = discoverChannels(scan.links, res.finalUrl);
    const verdict = judgeOfficial({
      companyName: target.name,
      domain: target.domain,
      finalUrl: res.finalUrl,
      httpStatus: res.status,
      phone: target.phone,
      regionSigungu: target.region_sigungu,
      sharedCompanyCount: Math.max(sharedCompanyCount - 1, 0),
      scan,
      contactCandidates: candidates,
    });

    return {
      verdict,
      candidates,
      channels,
      robotsAllowed: true,
      httpStatus: res.status,
      hasNoindex: scan.hasNoindex,
      // 변경 탐지용. 본문은 저장하지 않고 지문만 남긴다.
      contentHash: createHash("sha256").update(res.body).digest("hex").slice(0, 32),
      crawledPages: 1,
    };
  } catch (err) {
    ctx.logger.warn("homepage.fetch_failed", { websiteId: target.website_id, error: message(err) });
    return { ...empty, robotsAllowed: true, verdict: unavailableVerdict("fetch_failed", target.domain) };
  }
}

async function persist(ctx: FetchingStageContext, target: Target, outcome: Inspection): Promise<void> {
  const { verdict } = outcome;
  await ctx.sql.begin(async (tx) => {
    await tx`
      insert into website_observations (
        website_id, attempt_id, official_status, official_score, signals,
        robots_allowed, has_noindex, has_contact_form_only, http_status,
        tech_signals, crawled_pages, content_hash
      ) values (
        ${target.website_id}, ${ctx.attemptId}, ${verdict.status}::official_status, ${verdict.score},
        ${tx.json(verdict.signals)}, ${outcome.robotsAllowed}, ${outcome.hasNoindex},
        ${verdict.hasContactFormOnly}, ${outcome.httpStatus},
        ${tx.json({ domainClass: verdict.domainClass })}, ${outcome.crawledPages}, ${outcome.contentHash}
      )
      on conflict (website_id, attempt_id) do update set
        official_status = excluded.official_status,
        official_score = excluded.official_score,
        signals = excluded.signals,
        robots_allowed = excluded.robots_allowed,
        has_noindex = excluded.has_noindex,
        has_contact_form_only = excluded.has_contact_form_only,
        http_status = excluded.http_status,
        tech_signals = excluded.tech_signals,
        crawled_pages = excluded.crawled_pages,
        content_hash = excluded.content_hash,
        observed_at = now()
    `;

    // 게이트: 공식으로 인정된 사이트의 것만 남긴다 (설계서 스테이지 6·7 선행 조건).
    // 공식이 아닌 페이지가 링크한 블로그는 그 업체의 공식 채널이 아니다.
    const keep = verdict.status === "confirmed" || verdict.status === "likely";
    if (!keep) return;

    for (const channel of outcome.channels) {
      await tx`
        insert into channels (company_id, type, url)
        values (${target.company_id}, ${channel.type}::channel_type, ${channel.url})
        on conflict (company_id, type, url) do nothing
      `;
    }

    for (const candidate of outcome.candidates) {
      await tx`
        insert into contact_pages (website_id, attempt_id, url, page_kind, link_text, confidence)
        values (${target.website_id}, ${ctx.attemptId}, ${candidate.url},
                ${candidate.pageKind}, ${candidate.linkText}, ${candidate.confidence})
        on conflict (website_id, attempt_id, url) do update set
          page_kind = excluded.page_kind,
          link_text = excluded.link_text,
          confidence = excluded.confidence
      `;
    }
  });
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
