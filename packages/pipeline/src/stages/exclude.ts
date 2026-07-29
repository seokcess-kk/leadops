import { CompanyStatus, RawCandidate } from "@leadops/core";
import { decideExclusion, excludeSettingsFrom } from "../exclude";
import { emptyResult, type StageContext, type StageHandler, type StageResult } from "./types";

/**
 * 스테이지 3 — 기본 제외 (설계서 5.3 스테이지 4).
 *
 * 이번 attempt 에서 관측된 업체에 폐업·휴업·대형·가맹100+ 규칙을 적용한다.
 *
 * 원칙: **제외를 되돌릴 수 있어야 한다.** 규칙을 고쳐 재실행하면 이전에 제외됐던
 * 업체가 다시 통과해야 하므로, 이 스테이지는 매번 `excluded_reason` 을 새로 계산한다
 * (한 번 제외된 업체를 영구히 배제하지 않는다).
 */
export const excludeStage: StageHandler = {
  stage: "exclude_basic",
  dependsOn: ["normalize"],

  async run(ctx: StageContext): Promise<StageResult> {
    const settings = excludeSettingsFrom(ctx.settings);
    const result = emptyResult();
    const BATCH = 500;
    let offset = 0;

    for (;;) {
      const rows = await ctx.sql<
        Array<{
          id: string;
          name: string;
          industry: string;
          status: string;
          size_signals: Record<string, number>;
        }>
      >`
        select c.id, c.name, c.industry, c.status, c.size_signals
        from companies c
        join company_observations o on o.company_id = c.id
        where o.attempt_id = ${ctx.attemptId}
        order by c.id
        limit ${BATCH} offset ${offset}
      `;
      if (rows.length === 0) break;
      offset += rows.length;

      for (const row of rows) {
        result.processed++;
        // 제외 규칙은 RawCandidate 형태를 받으므로 필요한 필드만 채워 재구성한다.
        const shaped = RawCandidate.parse({
          source: "db",
          externalId: row.id,
          industry: row.industry,
          name: row.name,
          status: CompanyStatus.parse(row.status),
          sizeSignals: row.size_signals ?? {},
          raw: null,
        });

        const decision = decideExclusion(shaped, settings);
        await ctx.sql`
          update companies
          set excluded_reason = ${decision.excluded ? `${decision.reason}: ${decision.detail}` : null},
              size_tier = ${decision.sizeTier},
              updated_at = now()
          where id = ${row.id}
        `;

        if (decision.excluded) {
          result.skipped[decision.reason!] = (result.skipped[decision.reason!] ?? 0) + 1;
        } else {
          result.passed++;
        }
      }
    }

    result.note = `${result.processed}개 중 ${result.passed}개 통과`;
    return result;
  },
};
