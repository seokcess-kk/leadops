import { parseFeed } from "@leadops/adapters";
import { computeActivity, isActive, type ActivityMetrics } from "../activity";
import { describeChannel } from "../channels";
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
 * 스테이지 6 — 공식 채널 활성도 (설계서 5.3 스테이지 7).
 *
 * 채널 목록은 `homepage_detect` 가 공식 홈페이지의 링크에서 이미 뽑아 뒀다. 여기서는
 * 발행 이력만 가져와 활성도를 산출한다.
 *
 * ❗ **이 스테이지는 네이버 API 를 쓰지 않는다.** 설계서 3절이 "ORS 없이 성립하는 축소
 *    파이프라인을 1급 경로로 유지한다" 고 정한 축이 바로 이것이다. 네이버 서면 승인
 *    여부와 무관하게 동작해야 하므로 공개 RSS·Atom 피드만 쓴다. 유튜브도 Data API 가
 *    아니라 공개 피드(`feeds/videos.xml`)를 쓴다 — 키도 쿼터도 필요 없다.
 *
 * ❗ 피드 **본문은 파싱하지도 저장하지도 않는다** (제50조의2 · 결론 A).
 *    남기는 것은 발행 시각에서 계산한 집계와 제목에서 분류한 성격 분포뿐이다.
 *
 * 실패도 관측이다. 가져오지 못한 채널은 `analyzable = false` 와 사유를 남긴다 —
 * 그래야 다음 배치에서 다시 잡히지 않고 스테이지가 끝난다.
 */

const FEED_CONTENT_TYPES = Object.freeze([
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "application/rdf+xml",
  // 피드를 text/html 로 내보내는 서버가 흔하다. 파서가 형식을 보고 판단한다.
  "text/html",
  "text/plain",
]);

const CONCURRENCY = 4;
const BATCH = 300;

interface Target {
  channel_id: string;
  company_id: string;
  type: string;
  url: string;
}

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

export const channelStage: StageHandler = {
  stage: "channel_analyze",
  dependsOn: ["homepage_detect"],

  async run(ctx: StageContext): Promise<StageResult> {
    const fetching = requireFetching(ctx, "channel_analyze");
    const result = emptyResult();

    // 공식 채널이 하나도 없는 업체를 조용히 넘기지 않는다.
    const [none] = await ctx.sql<Array<{ n: string }>>`
      select count(*)::text as n
      from company_observations o
      join companies c on c.id = o.company_id
      where o.attempt_id = ${ctx.attemptId}
        and c.excluded_reason is null
        and not exists (select 1 from channels ch where ch.company_id = c.id)
    `;
    if (Number(none?.n ?? 0) > 0) result.skipped["no_official_channel"] = Number(none!.n);

    for (;;) {
      const targets = await ctx.sql<Target[]>`
        select ch.id as channel_id, ch.company_id, ch.type::text as type, ch.url
        from channels ch
        join company_observations o on o.company_id = ch.company_id and o.attempt_id = ${ctx.attemptId}
        where not exists (
          select 1 from channel_observations co
          where co.channel_id = ch.id and co.attempt_id = ${ctx.attemptId}
        )
        order by ch.id
        limit ${BATCH}
      `;
      if (targets.length === 0) break;

      await pool(targets, CONCURRENCY, async (target) => {
        result.processed++;
        const metrics = await analyze(fetching, target);

        if (!metrics.analyzable) {
          countSkip(result, metrics.unavailableReason ?? "unavailable");
        } else {
          result.passed++;
        }
        await persist(fetching, target, metrics);
      });
    }

    const [summary] = await ctx.sql<Array<{ active: string; dormant: string }>>`
      select count(*) filter (where is_active)::text as active,
             count(*) filter (where is_active = false)::text as dormant
      from channel_observations where attempt_id = ${ctx.attemptId}
    `;
    result.note =
      `채널 ${result.processed}개 분석 — 활성 ${summary?.active ?? "0"} · ` +
      `60일 무발행 ${summary?.dormant ?? "0"}`;
    return result;
  },
};

/** 채널 하나를 조사한다. **던지지 않는다** — 실패는 관측 결과다. */
async function analyze(ctx: FetchingStageContext, target: Target): Promise<ActivityMetrics> {
  const unavailable = (reason: string): ActivityMetrics => ({
    posts60d: 0,
    posts120d: 0,
    saturated: false,
    contentMix: { event: 0, info: 0, review: 0, notice: 0, etc: 0 },
    analyzable: false,
    unavailableReason: reason,
  });

  const described = describeChannel(target.url);
  if (!described) return unavailable("url_not_recognized");
  // SNS·플레이스·미해결 유튜브 핸들은 공개 피드가 없다. 존재 자체는 이미 기록돼 있다.
  if (!described.analyzable || !described.feedUrl) {
    return unavailable(described.unavailableReason ?? "no_public_feed");
  }

  try {
    const gate = await ctx.robots.check(described.feedUrl);
    if (!gate.allowed) return unavailable(gate.failure ? `robots_${gate.failure}` : "robots_disallowed");

    const res = await ctx.http.get(described.feedUrl, { acceptContentTypes: FEED_CONTENT_TYPES });
    const feed = parseFeed(res.body);
    if (feed.entries.length === 0 && res.body.trim().length > 0 && !looksLikeFeed(res.body)) {
      // 피드 주소가 HTML 페이지를 돌려줬다. 채널이 사라졌거나 주소 규칙이 바뀐 것이다.
      return unavailable("not_a_feed");
    }
    return computeActivity(feed.entries, feed.undatedCount);
  } catch (err) {
    ctx.logger.warn("channel.fetch_failed", {
      channelId: target.channel_id,
      platform: described.platform,
      error: err instanceof Error ? err.message : String(err),
    });
    return unavailable("feed_fetch_failed");
  }
}

/** 루트 요소만 보고 피드인지 판단한다. 빈 피드와 HTML 응답을 구분하기 위한 것이다. */
function looksLikeFeed(body: string): boolean {
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 4096));
}

async function persist(ctx: FetchingStageContext, target: Target, metrics: ActivityMetrics): Promise<void> {
  await ctx.sql`
    insert into channel_observations (
      channel_id, attempt_id, run_date, is_active, last_post_at, posts_60d, posts_120d,
      cadence_days, content_mix, analyzable, unavailable_reason, feed_saturated
    ) values (
      ${target.channel_id}, ${ctx.attemptId}, ${ctx.runDate}::date, ${isActive(metrics)},
      ${metrics.lastPostAt ?? null}::date, ${metrics.analyzable ? metrics.posts60d : null},
      ${metrics.analyzable ? metrics.posts120d : null}, ${metrics.cadenceDays ?? null},
      ${ctx.sql.json(metrics.contentMix)}, ${metrics.analyzable},
      ${metrics.unavailableReason ?? null}, ${metrics.saturated}
    )
    on conflict (channel_id, attempt_id, run_date) do update set
      is_active = excluded.is_active,
      last_post_at = excluded.last_post_at,
      posts_60d = excluded.posts_60d,
      posts_120d = excluded.posts_120d,
      cadence_days = excluded.cadence_days,
      content_mix = excluded.content_mix,
      analyzable = excluded.analyzable,
      unavailable_reason = excluded.unavailable_reason,
      feed_saturated = excluded.feed_saturated,
      observed_at = now()
  `;
}
