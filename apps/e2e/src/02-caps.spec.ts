import { expect, test } from "@playwright/test";
import type { Sql } from "postgres";
import { getSetting, NAMES, putRunTargets, putSetting, resetApprovalState } from "./seed";
import { gotoTodayWith, notice, ownerSql } from "./support";

/**
 * Phase 6 완료 기준 — 일 승인 상한 거부 · 업종 비율 위반 거부.
 *
 * ❗ **화면이 상한을 세지 않는다.** DB 가 세고(`approval_day_totals`·`approval_counters` 를
 *    `for update` 로 잠근 뒤 검사), API 가 409 로 옮기고, 화면은 그 사유를 보여 준다.
 *    그래서 이 스펙이 확인하는 것은 "화면이 막았는가" 가 아니라 **"서버가 막은 것을 화면이
 *    정확히 전달했는가"** 다.
 *
 * ❗ 설계서 완료 기준은 "동시 승인 51번째 거부" 다. 여기서는 상한을 1 로 낮춰 **같은 규칙**을
 *    검증한다 — 51행을 만드는 것은 규칙이 아니라 숫자를 검증하는 것이고, 브라우저를 통한
 *    직렬화 검증은 애초에 불가능하다. 행 잠금 직렬화는 `rpc.pg.test.ts` 가 동시 트랜잭션으로
 *    검증한다. 여기서는 **화면까지 도달하는 경로**를 본다.
 *
 * ❗ 상한은 **`runs.settings_snapshot`** 에서 읽힌다. live `settings` 만 바꾸면 판정은 그대로다
 *    (실행 도중 상한을 바꿔도 그 실행이 흔들리지 않게 한 설계다). 그래서 두 곳을 함께 바꾼다 —
 *    스냅샷은 판정용, live 설정은 화면 표시용이다.
 */

/** 판정 기준(스냅샷)과 표시 기준(live 설정)을 함께 맞춘다. */
async function applyTargets(sql: Sql, targets: Record<string, unknown>): Promise<void> {
  await putRunTargets(sql, targets);
  await putSetting(sql, "targets", targets);
}

let sql: Sql;
let originalTargets: Record<string, unknown>;

test.beforeAll(async () => {
  sql = ownerSql();
  originalTargets = await getSetting(sql, "targets");
});

test.afterAll(async () => {
  // 다른 스펙이 물려받지 않게 되돌린다.
  await applyTargets(sql, originalTargets);
  await resetApprovalState(sql);
  await sql.end({ timeout: 5 });
});

test.describe.configure({ mode: "serial" });

test("일 승인 상한에 닿으면 다음 승인이 409 로 거부된다", async ({ page }) => {
  await resetApprovalState(sql);
  // 상한 1. 업종 쿼터가 먼저 걸리지 않도록 비율은 열어 둔다 (quota = floor(1 × 1) = 1).
  await applyTargets(sql, { ...originalTargets, final_max: 1, industry_share_max: 1 });

  const first = NAMES.dailyCap[0];
  const second = NAMES.dailyCap[1];

  const firstRow = await gotoTodayWith(page, first);
  await firstRow.getByRole("button", { name: "승인" }).click();
  await expect(page.getByRole("row").filter({ hasText: first })).toHaveCount(0);

  // 두 번째 — 상한에 닿았으므로 서버가 거부해야 한다.
  const secondRow = await gotoTodayWith(page, second);
  await secondRow.getByRole("button", { name: "승인" }).click();

  await expect(notice(page, "daily_cap_reached")).toBeVisible();
  // ❗ 거부된 승인이 성공처럼 보이면 안 된다 — 행이 그대로 남아 있어야 한다.
  await expect(page.getByRole("row").filter({ hasText: second })).toBeVisible();

  const leads = await sql<Array<{ n: string }>>`select count(*)::text as n from leads`;
  expect(leads[0]?.n).toBe("1");
});

test("업종 비율 상한을 넘으면 409 로 거부된다", async ({ page }) => {
  await resetApprovalState(sql);
  // quota = floor(final_max × industry_share_max) = floor(10 × 0.1) = 1.
  // 일 상한(10)에는 닿지 않으므로 **업종 쿼터만** 발화한다.
  await applyTargets(sql, { ...originalTargets, final_max: 10, industry_share_max: 0.1 });

  const first = NAMES.industryQuota[0];
  const second = NAMES.industryQuota[1];

  const firstRow = await gotoTodayWith(page, first);
  await firstRow.getByRole("button", { name: "승인" }).click();
  await expect(page.getByRole("row").filter({ hasText: first })).toHaveCount(0);

  const secondRow = await gotoTodayWith(page, second);
  await secondRow.getByRole("button", { name: "승인" }).click();

  await expect(notice(page, "industry_quota_exceeded")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: second })).toBeVisible();

  const leads = await sql<Array<{ n: string }>>`select count(*)::text as n from leads`;
  expect(leads[0]?.n).toBe("1");
});

test("승인 상한은 화면의 승인 카운터에 그대로 보인다", async ({ page }) => {
  await resetApprovalState(sql);
  await applyTargets(sql, { ...originalTargets, final_max: 7, industry_share_max: 1 });

  await page.goto("/today");
  // MetricStrip 의 "승인" 칸이 live `settings` 의 `targets.final_max` 를 분모로 쓴다.
  await expect(page.getByText("/7")).toBeVisible();
});
