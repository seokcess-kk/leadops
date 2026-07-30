import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./src/env";

/**
 * E2E 설정 (설계서 10절 Phase 6 완료 기준).
 *
 * ❗ `workers: 1` · `fullyParallel: false` 다. 검증 대상이 **공유 상태**(승인 카운터·설정·
 *    검수 후보)이고, 그 상태의 전이 자체가 규칙이다. 병렬로 돌리면 상한 검증이 서로의
 *    카운터를 밟아 통과·실패가 무작위가 된다 (`vitest.pg.config.ts` 가 같은 이유로
 *    `sequence.concurrent: false` 를 쓴다).
 *
 * ❗ `retries: 0` 이다. 재시도로 감춰지는 실패는 이 화면에서 가장 위험한 종류다 —
 *    승인은 되돌릴 수 없고, 재시도한 승인이 두 번 세어질 수 있다.
 */
export default defineConfig({
  testDir: "./src",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env["CI"]),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  globalSetup: "./src/globalSetup.ts",
  globalTeardown: "./src/globalTeardown.ts",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    ...devices["Desktop Chrome"],
  },
});
