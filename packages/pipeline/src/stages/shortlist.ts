import { recommend, type RecommendInput } from "../recommend";
import { industryQuota, targetSettingsFrom } from "../targets";
import type { Weakness } from "../weakness";
import { countSkip, emptyResult, type StageContext, type StageHandler, type StageResult } from "./types";

/**
 * 스테이지 11·12 — 추천 서비스와 검수 후보 확정
 * (설계서 5.3 스테이지 12·13 · 부록 A.7).
 */

const BATCH = 200;

// ── 추천 ─────────────────────────────────────────────────────────────────────

interface ScoreRow {
  score_id: string;
  breakdown: { problem?: { items?: unknown[] }; propensity?: { items?: unknown[] } } | null;
  weaknesses: Weakness[] | null;
}

export const recommendStage: StageHandler = {
  stage: "recommend",
  dependsOn: ["score"],

  async run(ctx: StageContext): Promise<StageResult> {
    const result = emptyResult();

    // 게이트를 통과한 후보만 만든다. 추천은 영업 제안이므로 검수 대상이 아닌 업체에는
    // 쓸 곳이 없다. (점수·근거는 모든 업체에 남아 있으므로 진단은 그대로 가능하다.)
    //
    // ❗ offset 순회다 — `breakdown` 을 읽지 못해 건너뛴 행이 다시 잡히면 무한 루프가 된다.
    let offset = 0;
    for (;;) {
      const rows = await ctx.sql<ScoreRow[]>`
        select s.id as score_id, s.breakdown, s.weaknesses
        from scores s
        where s.attempt_id = ${ctx.attemptId}
          and s.gate_passed
          and s.invalidated_at is null
        order by s.id
        limit ${BATCH} offset ${offset}
      `;
      if (rows.length === 0) break;
      offset += rows.length;

      for (const row of rows) {
        result.processed++;
        const input = toRecommendInput(row);
        if (!input) {
          countSkip(result, "breakdown_unreadable");
          continue;
        }

        const rec = recommend(input);
        await ctx.sql`
          insert into recommendations (score_id, primary_service, secondary_services, rationale, rationale_source)
          values (${row.score_id}, ${rec.primaryService}, ${rec.secondaryServices as unknown as string[]},
                  ${rec.rationale}, ${rec.rationaleSource})
          on conflict (score_id) do update set
            primary_service = excluded.primary_service,
            secondary_services = excluded.secondary_services,
            rationale = excluded.rationale,
            rationale_source = excluded.rationale_source
        `;
        result.passed++;
      }
    }

    const [summary] = await ctx.sql<Array<{ service: string; n: string }>>`
      select r.primary_service as service, count(*)::text as n
      from recommendations r
      join scores s on s.id = r.score_id
      where s.attempt_id = ${ctx.attemptId}
      group by r.primary_service
      order by count(*) desc
      limit 1
    `;
    result.note =
      `추천 ${result.passed}건 생성` +
      (summary ? ` · 최다 주력: ${summary.service} (${summary.n}건)` : "") +
      " · 규칙 기반 (LLM 미사용)";
    return result;
  },
};

/** `scores.breakdown` 에서 추천 입력을 복원한다. 형태가 어긋나면 조용히 넘기지 않고 센다. */
function toRecommendInput(row: ScoreRow): RecommendInput | undefined {
  const problem = row.breakdown?.problem?.items;
  const propensity = row.breakdown?.propensity?.items;
  if (!Array.isArray(problem) || !Array.isArray(propensity)) return undefined;
  return {
    problem: { items: problem as RecommendInput["problem"]["items"] },
    propensity: { items: propensity as RecommendInput["propensity"]["items"] },
    weaknesses: Array.isArray(row.weaknesses) ? row.weaknesses : [],
  };
}

// ── 검수 후보 ────────────────────────────────────────────────────────────────

export const shortlistStage: StageHandler = {
  stage: "shortlist",
  dependsOn: ["score"],

  async run(ctx: StageContext): Promise<StageResult> {
    const targets = targetSettingsFrom(ctx.settings);
    const result = emptyResult();

    // ❗ 업종 쿼터는 **검수 후보 상한** 기준이다. 승인 시점의 쿼터(final_max 기준)는
    //    `decide_review_item` RPC 가 따로 강제한다 — 여기서 통과해도 승인에서 다시 막힌다.
    const perIndustry = industryQuota(targets.reviewMax, targets.industryShareMax);

    const candidates = await ctx.sql<
      Array<{ score_id: string; company_id: string; industry: string; total: string }>
    >`
      select s.id as score_id, s.company_id, c.industry, s.total::text as total
      from scores s
      join companies c on c.id = s.company_id
      where s.attempt_id = ${ctx.attemptId}
        and s.gate_passed
        and s.invalidated_at is null
        and c.do_not_contact = false
      order by s.total desc, s.company_id
    `;

    const perIndustryCount = new Map<string, number>();
    const chosen: Array<{ score_id: string; company_id: string; industry: string }> = [];

    for (const candidate of candidates) {
      result.processed++;
      if (chosen.length >= targets.reviewMax) {
        countSkip(result, "review_cap_reached");
        continue;
      }
      const used = perIndustryCount.get(candidate.industry) ?? 0;
      if (used >= perIndustry) {
        // 조용히 버리지 않는다. 업종이 쏠려 후보를 못 채운 것과 후보가 없는 것은 다르다.
        countSkip(result, `industry_quota:${candidate.industry}`);
        continue;
      }
      perIndustryCount.set(candidate.industry, used + 1);
      chosen.push(candidate);
    }

    await ctx.sql.begin(async (tx) => {
      for (const [index, item] of chosen.entries()) {
        await tx`
          insert into review_items (run_id, attempt_id, company_id, score_id, rank)
          values (${ctx.runId}, ${ctx.attemptId}, ${item.company_id}, ${item.score_id}, ${index + 1})
          on conflict (attempt_id, company_id) do update set
            score_id = excluded.score_id,
            rank = excluded.rank
        `;
      }
    });

    result.passed = chosen.length;
    const mix = [...perIndustryCount.entries()].map(([k, v]) => `${k} ${v}`).join(" / ");
    result.note =
      `게이트 통과 ${candidates.length}개 중 ${chosen.length}개를 검수 후보로 확정 ` +
      `(상한 ${targets.reviewMax} · 업종당 ${perIndustry})` +
      (mix ? ` — ${mix}` : "");

    if (candidates.length === 0) {
      ctx.logger.warn("shortlist.empty", {
        note:
          "게이트를 통과한 업체가 없습니다. 초기 실행에서는 유효 경쟁사 부족(A.6)이 " +
          "가장 흔한 원인입니다 — scores.gate_reason 을 확인하세요.",
      });
    }
    return result;
  },
};
