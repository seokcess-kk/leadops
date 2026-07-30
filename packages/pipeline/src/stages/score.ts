import { Industry, OfficialStatus } from "@leadops/core";
import type { PageKind } from "../contactPages";
import type { ChannelFact, CompetitorFact, OrsFact, ScoreFacts } from "../facts";
import { score, scoringSettingsFrom, type ScoreResult } from "../scoring";
import type { TechSignals } from "../weakness";
import { countSkip, emptyResult, toJson, type StageContext, type StageHandler, type StageResult } from "./types";

/**
 * 스테이지 10 — 3축 점수 (설계서 5.3 스테이지 11 · 부록 A).
 *
 * 관측을 순수 값(`ScoreFacts`)으로 옮긴 뒤 점수 로직에 넘긴다. 이 경계를 지키는 이유:
 *  1. **재현성** — 같은 관측이면 같은 점수가 나와야 한다 (Phase 5 완료 기준).
 *  2. 가중치를 바꿀 때 DB 없이 골드셋으로 회귀를 돌릴 수 있어야 한다.
 *
 * ❗ 점수가 참조한 관측 id 를 `score_inputs` 에 고정한다 (R2-23). 관측이 나중에
 *    갱신돼도 과거 점수를 재현할 수 있어야 한다.
 */

const BATCH = 100;

interface Row {
  company_id: string;
  industry: string;
  region_sigungu: string | null;
  size_tier: string | null;
  do_not_contact: boolean;
  last_scanned_at: string | null;
}

export const scoreStage: StageHandler = {
  stage: "score",
  dependsOn: ["channel_analyze", "search_analyze", "competitor_analyze"],

  async run(ctx: StageContext): Promise<StageResult> {
    const settings = scoringSettingsFrom(ctx.settings);
    const result = emptyResult();

    // 홈페이지 관측이 없는 업체는 채점 대상이 아니다. 조용히 사라지지 않도록 먼저 센다.
    const [unscored] = await ctx.sql<Array<{ n: string }>>`
      select count(*)::text as n
      from companies c
      join company_observations o on o.company_id = c.id and o.attempt_id = ${ctx.attemptId}
      where c.excluded_reason is null
        and not exists (
          select 1 from website_observations wo
          join websites w on w.id = wo.website_id
          where w.company_id = c.id and wo.attempt_id = ${ctx.attemptId}
        )
    `;
    if (Number(unscored?.n ?? 0) > 0) result.skipped["no_website_observation"] = Number(unscored!.n);

    // ❗ offset 순회다. "아직 점수가 없는 행" 을 조건으로 돌면, 채점할 수 없는 행을
    //    건너뛰는 순간 그 행이 다음 조회에 다시 잡혀 **무한 루프**가 된다.
    //    멱등성은 `on conflict do update` 가 보장한다.
    let offset = 0;
    for (;;) {
      const rows = await ctx.sql<Row[]>`
        select c.id as company_id, c.industry, c.region_sigungu, c.size_tier,
               c.do_not_contact, c.last_scanned_at::text as last_scanned_at
        from companies c
        join company_observations o on o.company_id = c.id and o.attempt_id = ${ctx.attemptId}
        join websites w on w.company_id = c.id
        join website_observations wo on wo.website_id = w.id and wo.attempt_id = ${ctx.attemptId}
        where c.excluded_reason is null
        group by c.id, c.industry, c.region_sigungu, c.size_tier, c.do_not_contact, c.last_scanned_at
        order by c.id
        limit ${BATCH} offset ${offset}
      `;
      if (rows.length === 0) break;
      offset += rows.length;

      for (const row of rows) {
        result.processed++;
        const gathered = await gather(ctx, row, settings.mode === "ors_enabled");
        if (!gathered) {
          countSkip(result, "gather_failed");
          continue;
        }

        const outcome = score(gathered.facts, settings, gathered.tech);
        await persist(ctx, row.company_id, outcome, gathered.inputs);

        if (outcome.gatePassed) result.passed++;
        else countSkip(result, "gate_failed");
      }
    }

    const [summary] = await ctx.sql<Array<{ n: string; passed: string; avg: string | null }>>`
      select count(*)::text as n,
             count(*) filter (where gate_passed)::text as passed,
             round(avg(total), 1)::text as avg
      from scores where attempt_id = ${ctx.attemptId}
    `;
    result.note =
      `${summary?.n ?? 0}개 채점 · 게이트 통과 ${summary?.passed ?? 0}개 · 평균 총점 ${summary?.avg ?? "-"}` +
      ` (모드: ${settings.mode})`;
    return result;
  },
};

interface Gathered {
  facts: ScoreFacts;
  tech: TechSignals;
  inputs: Array<{ kind: string; id: string }>;
}

/** 관측을 순수 값으로 옮긴다. 여기서만 SQL 을 안다. */
async function gather(ctx: StageContext, row: Row, orsMode: boolean): Promise<Gathered | undefined> {
  const inputs: Array<{ kind: string; id: string }> = [];

  const [site] = await ctx.sql<
    Array<{ id: string; official_status: string; has_noindex: boolean | null; signals: Record<string, unknown> }>
  >`
    select wo.id, wo.official_status::text as official_status, wo.has_noindex, wo.signals
    from website_observations wo
    join websites w on w.id = wo.website_id
    where w.company_id = ${row.company_id} and wo.attempt_id = ${ctx.attemptId}
    order by wo.official_score desc nulls last
    limit 1
  `;
  // 홈페이지 관측이 없으면 채점하지 않는다. 0점을 주면 "판별 실패" 와 "정말 나쁨" 이 섞인다.
  if (!site) return undefined;
  inputs.push({ kind: "website_obs", id: site.id });

  const contactPages = await ctx.sql<Array<{ page_kind: string }>>`
    select cp.page_kind
    from contact_pages cp
    join websites w on w.id = cp.website_id
    where w.company_id = ${row.company_id} and cp.attempt_id = ${ctx.attemptId}
  `;

  const channelRows = await ctx.sql<
    Array<{
      obs_id: string | null; type: string; analyzable: boolean | null;
      posts_60d: number | null; posts_120d: number | null;
      last_post_at: string | null; content_mix: Record<string, number> | null;
    }>
  >`
    select co.id as obs_id, ch.type::text as type, co.analyzable, co.posts_60d, co.posts_120d,
           co.last_post_at::text as last_post_at, co.content_mix
    from channels ch
    left join channel_observations co
      on co.channel_id = ch.id and co.attempt_id = ${ctx.attemptId}
    where ch.company_id = ${row.company_id}
  `;
  const channels: ChannelFact[] = channelRows.map((c) => {
    for (const id of c.obs_id ? [c.obs_id] : []) inputs.push({ kind: "channel_obs", id });
    return {
      type: c.type,
      analyzable: c.analyzable === true,
      posts60d: c.posts_60d ?? null,
      posts120d: c.posts_120d ?? null,
      lastPostAt: c.last_post_at ?? null,
      contentMix: c.content_mix ?? {},
    };
  });

  const orsRows = await ctx.sql<
    Array<{
      id: string; keyword: string; keyword_kind: string; provider: string;
      denominator: number; official_count: number; related_count: number; ors: string | null;
    }>
  >`
    select id::text as id, keyword, keyword_kind, provider, denominator,
           official_count, related_count, ors::text as ors
    from search_aggregates
    where company_id = ${row.company_id} and attempt_id = ${ctx.attemptId}
  `;
  const ors: OrsFact[] = orsRows.map((o) => {
    inputs.push({ kind: "search_agg", id: o.id });
    return {
      keyword: o.keyword,
      keywordKind: o.keyword_kind === "brand" ? "brand" : "nonbrand",
      provider: o.provider,
      denominator: o.denominator,
      officialCount: o.official_count,
      relatedCount: o.related_count,
      ors: o.ors === null ? null : Number(o.ors),
    };
  });

  const peerRows = await ctx.sql<
    Array<{
      id: string; is_valid: boolean; ors: string | null; recency_60d: number | null;
      diversity: number | null; channel_activity: string | null;
    }>
  >`
    select k.id, k.is_valid, m.ors::text as ors, m.recency_60d, m.diversity,
           m.channel_activity::text as channel_activity
    from competitors k
    left join competitor_metrics m on m.competitor_id = k.id
    where k.attempt_id = ${ctx.attemptId} and k.company_id = ${row.company_id}
  `;
  const competitors: CompetitorFact[] = peerRows.map((p) => {
    inputs.push({ kind: "competitor", id: p.id });
    return {
      competitorId: p.id,
      isValid: p.is_valid,
      ors: p.ors === null ? null : Number(p.ors),
      recency60d: p.recency_60d ?? null,
      diversity: p.diversity ?? null,
      channelActivity: p.channel_activity === null ? null : Number(p.channel_activity),
    };
  });

  const [local] = await ctx.sql<Array<{ n: string }>>`
    select count(*)::text as n from companies
    where industry = ${row.industry}
      and region_sigungu is not null and region_sigungu = ${row.region_sigungu}
      and excluded_reason is null
  `;

  // 분석 완료 비율: 해당되는 항목만 분모에 넣는다.
  const parts: number[] = [site.official_status === "unavailable" ? 0 : 1];
  if (channels.length > 0) parts.push(channels.filter((c) => c.analyzable).length / channels.length);
  if (orsMode) parts.push(ors.length > 0 ? 1 : 0);
  const completeness = parts.reduce((a, b) => a + b, 0) / parts.length;

  const signals = site.signals ?? {};
  return {
    facts: {
      companyId: row.company_id,
      industry: Industry.parse(row.industry),
      regionSigungu: row.region_sigungu,
      sizeTier: row.size_tier === "small" || row.size_tier === "mid" || row.size_tier === "large" ? row.size_tier : null,
      doNotContact: row.do_not_contact,
      officialStatus: OfficialStatus.parse(site.official_status),
      contactPageKinds: contactPages.map((p) => p.page_kind as PageKind),
      channels,
      ors,
      orsScored: orsMode && ors.length > 0,
      competitors,
      localCompetitionCount: Number(local?.n ?? 0),
      analysisCompleteness: completeness,
      lastScannedAt: row.last_scanned_at,
    },
    tech: {
      hasTitle: typeof signals["nameInTitle"] === "boolean" ? true : undefined,
      https: typeof signals["https"] === "boolean" ? (signals["https"] as boolean) : undefined,
      hasNoindex: site.has_noindex ?? undefined,
    },
    inputs,
  };
}

async function persist(
  ctx: StageContext,
  companyId: string,
  outcome: ScoreResult,
  inputs: ReadonlyArray<{ kind: string; id: string }>,
): Promise<void> {
  await ctx.sql.begin(async (tx) => {
    const [scoreRow] = await tx<Array<{ id: string }>>`
      insert into scores (
        run_id, attempt_id, company_id,
        axis_problem, axis_propensity, axis_confidence, total,
        breakdown, weaknesses, competitor_gap_available, ors_scored,
        rule_version, gate_passed, gate_reason
      ) values (
        ${ctx.runId}, ${ctx.attemptId}, ${companyId},
        ${outcome.problem.points}, ${outcome.propensity.points}, ${outcome.confidence.points},
        ${outcome.total},
        ${tx.json(toJson({
          problem: outcome.problem,
          propensity: outcome.propensity,
          confidence: outcome.confidence,
          normalized: outcome.normalized,
          totalMax: outcome.totalMax,
          marketingActivity: outcome.marketingActivity,
          tally: outcome.tally,
        }))},
        ${tx.json(toJson(outcome.weaknesses))},
        ${outcome.competitorGapAvailable}, ${outcome.orsScored},
        ${outcome.ruleVersion}, ${outcome.gatePassed}, ${outcome.gateReason ?? null}
      )
      on conflict (attempt_id, company_id) do update set
        axis_problem = excluded.axis_problem,
        axis_propensity = excluded.axis_propensity,
        axis_confidence = excluded.axis_confidence,
        total = excluded.total,
        breakdown = excluded.breakdown,
        weaknesses = excluded.weaknesses,
        competitor_gap_available = excluded.competitor_gap_available,
        ors_scored = excluded.ors_scored,
        rule_version = excluded.rule_version,
        gate_passed = excluded.gate_passed,
        gate_reason = excluded.gate_reason
      returning id
    `;
    const scoreId = scoreRow!.id;

    // 참조한 관측을 고정한다 (R2-23). 재실행 시 남은 것을 지우고 다시 넣는다.
    await tx`delete from score_inputs where score_id = ${scoreId}`;
    for (const input of inputs) {
      await tx`
        insert into score_inputs (score_id, input_kind, input_id)
        values (${scoreId}, ${input.kind}, ${input.id})
        on conflict do nothing
      `;
    }
  });
}
