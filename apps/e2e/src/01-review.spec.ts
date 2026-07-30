import { expect, test } from "@playwright/test";
import type { Sql } from "postgres";
import { MX_DOMAIN } from "./env";
import { NAMES, resetApprovalState } from "./seed";
import { gotoTodayWith, ownerSql } from "./support";

/**
 * Phase 6 완료 기준 — 검수 → 연락처 입력 → MX → 승인 → 리드 → export.
 *
 * ❗ MX 는 **실제 DNS** 로 검증된다. 가짜 리졸버를 끼우면 승인 게이트를 검증한 것이 아니다.
 *    그래서 이 스펙은 네트워크가 필요하다 (`LEADOPS_E2E_MX_DOMAIN` 으로 도메인을 바꿀 수 있다).
 */

const ADDRESS = `e2e-contact@${MX_DOMAIN}`;

let sql: Sql;

test.beforeAll(async () => {
  sql = ownerSql();
  // 상한에 이미 닿아 있으면 승인이 거절된다 — 이 스펙은 0 에서 시작한다.
  await resetApprovalState(sql);
});

test.afterAll(async () => {
  await sql.end({ timeout: 5 });
});

test.describe.configure({ mode: "serial" });

test("검수 목록이 실데이터를 읽는다", async ({ page }) => {
  const row = await gotoTodayWith(page, NAMES.happyPath);
  await expect(row).toContainText("치과");
  // 이메일이 없으면 행의 승인 버튼은 눌릴 수 없다 (MX 통과 이메일이 승인의 전제다).
  await expect(row.getByRole("button", { name: "승인" })).toBeDisabled();
});

test("연락처 페이지 근거로 이메일을 입력하면 서버가 MX 까지 검증한다", async ({ page }) => {
  const row = await gotoTodayWith(page, NAMES.happyPath);
  // `exact` 가 없으면 체크박스 셀(`… 선택`)까지 잡혀 strict mode 위반이 된다.
  await row.getByRole("cell", { name: NAMES.happyPath, exact: true }).click();

  const drawer = page.getByRole("dialog", { name: `${NAMES.happyPath} 상세` });
  await expect(drawer).toBeVisible();
  // MX 통과 이메일이 없으므로 승인은 잠겨 있어야 한다.
  await expect(drawer.getByRole("button", { name: "승인" })).toBeDisabled();

  await drawer.getByLabel("업무용 이메일").fill(ADDRESS);
  await drawer.getByLabel("이메일 유형").selectOption("inquiry");
  await drawer.getByRole("button", { name: "검증 후 저장" }).click();

  // 서버가 MX 를 통과시켰을 때만 승인이 열린다 — 화면이 스스로 판정하지 않는다.
  await expect(drawer.getByRole("button", { name: "승인" })).toBeEnabled({ timeout: 30_000 });

  // ❗ mx_ok 는 서버 권한으로만 기록된다 (마이그레이션 0010). DB 에 실제로 남았는지 본다.
  const rows = await sql<Array<{ mx_ok: boolean | null; acquisition_method: string }>>`
    select mx_ok, acquisition_method from emails where address = ${ADDRESS}
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.mx_ok).toBe(true);
  expect(rows[0]?.acquisition_method).toBe("manual_entry");
});

test("승인하면 리드가 되고 검수 대기에서 사라진다", async ({ page }) => {
  const row = await gotoTodayWith(page, NAMES.happyPath);
  // `exact` 가 없으면 체크박스 셀(`… 선택`)까지 잡혀 strict mode 위반이 된다.
  await row.getByRole("cell", { name: NAMES.happyPath, exact: true }).click();

  const drawer = page.getByRole("dialog", { name: `${NAMES.happyPath} 상세` });
  await drawer.getByRole("button", { name: "승인" }).click();

  // 낙관적 갱신을 하지 않으므로, 사라졌다는 것은 서버가 승인을 확인했다는 뜻이다.
  await expect(page.getByRole("row").filter({ hasText: NAMES.happyPath })).toHaveCount(0);

  await page.goto("/leads");
  const leadRow = page.getByRole("row").filter({ hasText: NAMES.happyPath });
  await expect(leadRow).toBeVisible();
  await expect(leadRow).toContainText(ADDRESS);
});

test("export 는 워터마크가 붙은 CSV 를 내려주고 감사 로그를 남긴다", async ({ page }) => {
  await page.goto("/leads");
  await expect(page.getByRole("row").filter({ hasText: NAMES.happyPath })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV Export" }).click();
  const file = await download;

  expect(file.suggestedFilename()).toContain("leadops-leads-");
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString("utf8");

  // 워터마크 열이 없으면 유출 시 출처를 되짚을 수 없다.
  expect(csv).toContain("exported_by");
  expect(csv).toContain("exported_at");
  expect(csv).toContain(NAMES.happyPath);
  expect(csv).toContain(ADDRESS);
  // BOM — 없으면 Excel 이 한글을 깨뜨린다.
  expect(csv.charCodeAt(0)).toBe(0xfeff);

  // ❗ export 는 감사 대상이다. 화면을 거쳐도 기록이 남아야 한다.
  const audit = await sql<Array<{ after: { count: number } }>>`
    select after from audit_log where action = 'leads.export' order by created_at desc limit 1
  `;
  expect(audit[0]?.after.count).toBe(1);

  const leads = await sql<Array<{ export_status: string; export_count: number }>>`
    select export_status, export_count from leads
  `;
  expect(leads[0]?.export_status).toBe("exported");
  expect(leads[0]?.export_count).toBe(1);
});
