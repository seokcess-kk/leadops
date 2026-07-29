import { adapterFor, type SourceAdapter } from "@leadops/adapters";
import { configError, Industry, RawCandidate } from "@leadops/core";
import { countSkip, emptyResult, type StageContext, type StageHandler, type StageResult } from "./types";

/**
 * 스테이지 1 — 후보 수집.
 *
 * 어댑터에서 받은 원본을 `raw_candidates` 에 그대로 넣는다. 정규화는 다음 스테이지다.
 * 두 단계를 나눈 이유: 수집은 외부 API 에 의존하고 정규화는 순수 로직이므로,
 * 정규화 규칙을 고쳤을 때 **수집을 다시 하지 않고** 재실행할 수 있어야 한다.
 *
 * 멱등: `unique (attempt_id, source, external_id)` + `on conflict do nothing`.
 */
export const collectStage: StageHandler = {
  stage: "collect",
  dependsOn: [],

  async run(ctx: StageContext, payload: Record<string, unknown>): Promise<StageResult> {
    const industry = Industry.parse(payload["industry"]);
    const limit = typeof payload["limit"] === "number" ? payload["limit"] : 500;

    const adapter: SourceAdapter = adapterFor(ctx.adapters, industry);
    if (!adapter.verifiedAgainstLiveApi) {
      // 막지는 않는다 — 검증 전에도 파이프라인을 돌려봐야 하기 때문이다.
      // 다만 결과가 "검증된 수집" 으로 오해되지 않도록 반드시 남긴다.
      ctx.logger.warn("stage.collect.unverified_adapter", {
        source: adapter.sourceName,
        industry,
        note: "이 어댑터는 실 API 로 검증되지 않았습니다. 결과를 확정으로 다루지 마세요.",
      });
    }

    const result = emptyResult();
    const batch: RawCandidate[] = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const rows = batch.map((c) => ({
        attempt_id: ctx.attemptId,
        source: c.source,
        external_id: c.externalId,
        industry: c.industry,
        payload: ctx.sql.json(c as unknown as Record<string, string>),
      }));
      const inserted = await ctx.sql`
        insert into raw_candidates ${ctx.sql(rows, "attempt_id", "source", "external_id", "industry", "payload")}
        on conflict (attempt_id, source, external_id) do nothing
        returning id
      `;
      result.passed += inserted.length;
      if (inserted.length < batch.length) {
        result.skipped["duplicate_in_attempt"] =
          (result.skipped["duplicate_in_attempt"] ?? 0) + (batch.length - inserted.length);
      }
      batch.length = 0;
    };

    for await (const candidate of adapter.fetchCandidates(industry, { limit })) {
      result.processed++;
      const parsed = RawCandidate.safeParse(candidate);
      if (!parsed.success) {
        // 어댑터가 계약을 어겼다. 조용히 넘기지 않고 센다.
        countSkip(result, "invalid_shape");
        ctx.logger.warn("stage.collect.invalid_candidate", {
          source: adapter.sourceName,
          externalId: String((candidate as { externalId?: unknown }).externalId ?? "?"),
          issues: parsed.error.issues.length,
        });
        continue;
      }
      batch.push(parsed.data);
      if (batch.length >= 200) await flush();
    }
    await flush();

    result.note = `${adapter.sourceName} → ${result.passed}건 적재`;
    return result;
  },
};

/** 업종별 collect 잡의 payload 를 만든다. */
export function collectPayloads(
  industries: readonly Industry[],
  perIndustryLimit: number,
): Array<{ idempotencyKey: string; payload: Record<string, unknown> }> {
  if (perIndustryLimit <= 0) throw configError("수집 상한은 1 이상이어야 합니다", { perIndustryLimit });
  return industries.map((industry) => ({
    idempotencyKey: `collect:${industry}`,
    payload: { industry, limit: perIndustryLimit },
  }));
}
