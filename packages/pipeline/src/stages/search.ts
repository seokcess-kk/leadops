import { ORS_CHANNELS, type SearchAdapter, type SearchResult } from "@leadops/adapters";
import { generateKeywords } from "../keywords";
import { aggregateAll, type ChannelAggregate, type ClassifiedHit, type OrsContext } from "../ors";
import { QuotaGuard, quotaSettingsFrom } from "../quota";
import { countSkip, emptyResult, type StageContext, type StageHandler, type StageResult } from "./types";

/**
 * 스테이지 7 — 검색 분석 · ORS (설계서 5.3 스테이지 8 · 3절).
 *
 * ⚠️ **ORS 는 배점 0 의 shadow feature 다.** 이 스테이지는 값을 산출해 기록만 하고,
 *    점수에 반영할지는 Phase 5 의 점수 로직이 `FEATURE_ORS` 상태를 보고 정한다.
 *
 * ❗ 검색 어댑터가 없으면(`FEATURE_ORS=off`) **실패가 아니라 건너뛴다.** ORS 없는 축소
 *    파이프라인이 1급 경로이기 때문이다(설계서 3절). 홈페이지 판별에서 HttpClient 가
 *    없을 때 에러를 내는 것과 다르다 — 거기서는 없는 것이 설정 실수이고, 여기서는
 *    없는 것이 기본값이다.
 *
 * 쿼터: 호출 **전에** 선점한다. 한도에 닿으면 그 자리에서 멈추고 실행을 `partial` 로
 * 끝낸다(설계서 4.1). 조용히 줄여서 계속하지 않는다.
 */

/** 분류 규칙 버전. 음성 결과를 사후 감사할 때 어떤 규칙으로 판정했는지 알아야 한다(R2-14). */
const CLASSIFIER_VERSION = "ors-v1-2026-07-30";

/** 업체당 비브랜드 키워드 수. 설계서 4.1 의 호출 예산이 3개를 전제한다. */
const NONBRAND_KEYWORDS = 3;

const DISPLAY = 30;
const BATCH = 100;

interface Target {
  company_id: string;
  name: string;
  industry: string;
  region_sigungu: string | null;
}

export const searchStage: StageHandler = {
  stage: "search_analyze",
  dependsOn: ["homepage_detect"],

  async run(ctx: StageContext): Promise<StageResult> {
    const result = emptyResult();

    const adapter = ctx.search;
    if (!adapter) {
      result.note = "검색 어댑터 없음 — ORS 산출을 건너뛴다 (FEATURE_ORS=off · 축소 파이프라인)";
      result.skipped["ors_disabled"] = 1;
      return result;
    }
    if (!adapter.verifiedAgainstLiveApi) {
      ctx.logger.warn("stage.search.unverified_adapter", {
        source: adapter.sourceName,
        note: "이 어댑터는 실 API 로 검증되지 않았습니다. ORS 를 확정으로 다루지 마세요.",
      });
    }

    const quota = new QuotaGuard(ctx.sql, ctx.runId, {
      provider: adapter.sourceName,
      dailyCap: quotaSettingsFrom(ctx.settings).naverDailyCap,
      unit: "call",
    });

    let exhausted = false;

    for (;;) {
      if (exhausted) break;
      const targets = await ctx.sql<Target[]>`
        select distinct c.id as company_id, c.name, c.industry, c.region_sigungu
        from companies c
        join company_observations o on o.company_id = c.id and o.attempt_id = ${ctx.attemptId}
        join websites w on w.company_id = c.id
        join website_observations wo on wo.website_id = w.id and wo.attempt_id = ${ctx.attemptId}
        where c.excluded_reason is null
          and wo.official_status in ('confirmed', 'likely')
          and not exists (
            select 1 from search_aggregates sa
            where sa.attempt_id = ${ctx.attemptId} and sa.company_id = c.id
          )
        order by c.id
        limit ${BATCH}
      `;
      if (targets.length === 0) break;

      for (const target of targets) {
        if (exhausted) break;
        result.processed++;

        const keywords = generateKeywords(
          {
            name: target.name,
            industry: target.industry as Parameters<typeof generateKeywords>[0]["industry"],
            regionSigungu: target.region_sigungu,
          },
          NONBRAND_KEYWORDS,
        );
        if (keywords.length === 0) {
          countSkip(result, "no_keyword");
          continue;
        }
        await persistKeywords(ctx, target.company_id, keywords);

        const orsCtx = await buildOrsContext(ctx, target);
        let wroteAny = false;

        for (const keyword of keywords) {
          const kind = keyword.kind === "brand" ? "brand" : "nonbrand";
          const results: SearchResult[] = [];

          for (const provider of ORS_CHANNELS) {
            const entryKey = `${ctx.attemptId}:${target.company_id}:${keyword.keyword}:${provider}`;
            const reservation = await quota.reserve(adapter.unitsPerCall, entryKey);
            if (!reservation.granted) {
              ctx.logger.warn("stage.search.quota_exhausted", {
                provider: adapter.sourceName,
                used: reservation.used,
                cap: reservation.cap,
              });
              countSkip(result, "quota_exhausted");
              exhausted = true;
              break;
            }
            try {
              results.push(await adapter.search(provider, keyword.keyword, DISPLAY));
            } catch (err) {
              // 채널 하나가 실패해도 나머지로 집계한다. 사유는 반드시 센다.
              countSkip(result, `search_failed:${provider}`);
              ctx.logger.warn("stage.search.channel_failed", {
                companyId: target.company_id,
                provider,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // 일부 채널만 성공했어도 그만큼은 남긴다. 행이 없는 것과 denominator 0 인 것은
          // 다른 사실이고, Phase 5 는 그 둘을 구분해야 한다.
          if (results.length > 0) {
            const { aggregates, dedupedHits } = aggregateAll(results, orsCtx);
            await persistAggregates(ctx, target.company_id, keyword.keyword, kind, aggregates, dedupedHits);
            wroteAny = true;
          }
          // ❗ 소진 검사는 `continue` 보다 **먼저** 와야 한다. 뒤에 두면 다음 키워드로 넘어가
          //    쿼터를 다시 두드리고, 소진 카운트가 키워드 수만큼 부풀려진다.
          if (exhausted) break;
        }

        if (wroteAny) result.passed++;
        else countSkip(result, "no_aggregate");
      }
    }

    const [summary] = await ctx.sql<Array<{ rows: string; scored: string }>>`
      select count(*)::text as rows, count(ors)::text as scored
      from search_aggregates where attempt_id = ${ctx.attemptId}
    `;
    const rows = Number(summary?.rows ?? 0);
    const scored = Number(summary?.scored ?? 0);
    // 설계서 M6: ORS 산출 가능률 ≥ 90%
    const rate = rows > 0 ? Math.round((scored / rows) * 100) : 0;
    result.note =
      `업체 ${result.passed}곳 집계 · 채널행 ${rows}건 중 ${scored}건에서 ORS 산출 (${rate}%)` +
      (exhausted ? " · 쿼터 소진으로 중단" : "");

    if (rows > 0 && rate < 90) {
      ctx.logger.warn("stage.search.low_ors_rate", {
        rate,
        note: "설계서 M6 기준(≥90%) 미달. 키워드 템플릿 점검이 필요합니다.",
      });
    }
    return result;
  },
};

async function persistKeywords(
  ctx: StageContext,
  companyId: string,
  keywords: ReturnType<typeof generateKeywords>,
): Promise<void> {
  for (const k of keywords) {
    await ctx.sql`
      insert into company_keywords (company_id, keyword, kind, priority, source, approved)
      values (${companyId}, ${k.keyword}, ${k.kind}, ${k.priority}, ${k.source}, true)
      on conflict (company_id, keyword) do update set
        kind = excluded.kind, priority = excluded.priority
    `;
  }
}

/** 공식 도메인·채널 목록. 어떤 결과가 "그 업체의 콘텐츠" 인지 판정하는 근거다. */
async function buildOrsContext(ctx: StageContext, target: Target): Promise<OrsContext> {
  const sites = await ctx.sql<Array<{ domain: string }>>`
    select distinct w.domain
    from websites w
    join website_observations wo on wo.website_id = w.id and wo.attempt_id = ${ctx.attemptId}
    where w.company_id = ${target.company_id} and wo.official_status in ('confirmed', 'likely')
  `;
  const channels = await ctx.sql<Array<{ url: string }>>`
    select url from channels where company_id = ${target.company_id}
  `;
  return {
    companyName: target.name,
    officialDomains: sites.map((s) => s.domain),
    officialChannelUrls: channels.map((c) => c.url),
  };
}

async function persistAggregates(
  ctx: StageContext,
  companyId: string,
  keyword: string,
  keywordKind: "brand" | "nonbrand",
  aggregates: readonly ChannelAggregate[],
  dedupedHits: readonly ClassifiedHit[],
): Promise<void> {
  const hitsByHash = new Map(dedupedHits.map((h) => [h.urlHash, h]));

  await ctx.sql.begin(async (tx) => {
    for (const aggregate of aggregates) {
      const [row] = await tx<Array<{ id: string }>>`
        insert into search_aggregates (
          attempt_id, company_id, keyword, keyword_kind, provider,
          total_returned, denominator, related_count, official_count,
          recency_dist, all_url_hashes, classifier_version, ors
        ) values (
          ${ctx.attemptId}, ${companyId}, ${keyword}, ${keywordKind}, ${aggregate.provider},
          ${aggregate.totalReturned}, ${aggregate.denominator}, ${aggregate.relatedCount},
          ${aggregate.officialCount}, ${tx.json(aggregate.recencyDist)},
          ${aggregate.hits.map((h) => h.urlHash)}, ${CLASSIFIER_VERSION}, ${aggregate.ors}
        )
        on conflict (attempt_id, company_id, keyword, provider) do update set
          total_returned = excluded.total_returned,
          denominator = excluded.denominator,
          related_count = excluded.related_count,
          official_count = excluded.official_count,
          recency_dist = excluded.recency_dist,
          all_url_hashes = excluded.all_url_hashes,
          classifier_version = excluded.classifier_version,
          ors = excluded.ors,
          collected_at = now()
        returning id
      `;
      const aggregateId = row!.id;

      // 채널 간 중복은 먼저 본 채널에만 남긴다 (unique (attempt, company, keyword, url_hash)).
      for (const hit of aggregate.hits) {
        if (hitsByHash.get(hit.urlHash) !== hit) continue;
        await tx`
          insert into search_hits (
            aggregate_id, attempt_id, company_id, keyword, rank, channel_type,
            is_official, url, url_hash, title, published_at, recency
          ) values (
            ${aggregateId}, ${ctx.attemptId}, ${companyId}, ${keyword}, ${hit.rank},
            ${hit.channelType}::channel_type, ${hit.isOfficial}, ${hit.url}, ${hit.urlHash},
            ${hit.title}, ${hit.publishedAt ? hit.publishedAt.toISOString().slice(0, 10) : null}::date,
            ${hit.recency}::recency_bucket
          )
          on conflict (attempt_id, company_id, keyword, url_hash) do nothing
        `;
      }
    }
  });
}

/** 워커가 어댑터를 주입할 때 쓰는 타입 재수출. */
export type { SearchAdapter };
