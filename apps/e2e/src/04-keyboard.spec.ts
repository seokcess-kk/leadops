import { expect, test, type Page } from "@playwright/test";
import type { Sql } from "postgres";
import { NAMES } from "./seed";
import { gotoTodayWith, ownerSql, reviewRow } from "./support";

/**
 * Phase 6 완료 기준 — 키보드 전체 조작 (설계서 §8.2).
 *
 *   j/k 이동 · Space 선택 · x 제외 · e 이메일 폼 · Enter 상세 · 1~4 사유 · Esc 취소
 *
 * ❗ 검수는 하루 수십 건을 훑는 작업이다. 마우스로만 가능하면 실제로 쓰이지 않는다.
 * ❗ 커서 위치는 `aria-selected` 로 확인한다 — 클래스로 확인하면 스타일을 바꿀 때마다
 *    검증이 깨지거나, 더 나쁘게는 스타일만 맞고 상태는 틀린 것을 통과시킨다.
 */

const [first, second, third] = NAMES.keyboard;

/** 검수 목록을 키보드 후보 3건으로 좁힌다. 필터도 함께 검증된다. */
async function focusKeyboardSet(page: Page): Promise<void> {
  await gotoTodayWith(page, first);
  await page.getByLabel("업체명·지역 검색").fill("E2E키보드");
  await expect(page.getByRole("row").filter({ hasText: "E2E키보드" })).toHaveCount(3);
  // ❗ 입력 필드에 포커스가 남아 있으면 전역 키 핸들러가 의도적으로 비활성이다.
  //    포커스를 빼지 않으면 j/k 가 검색어에 타이핑된다.
  await page.getByLabel("업체명·지역 검색").blur();
}

test.describe.configure({ mode: "serial" });

let sql: Sql;

test.beforeAll(() => {
  sql = ownerSql();
});

test.afterAll(async () => {
  await sql.end({ timeout: 5 });
});

test("j/k 로 커서가 이동하고 끝에서 넘치지 않는다", async ({ page }) => {
  await focusKeyboardSet(page);

  await expect(reviewRow(page, first)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("j");
  await expect(reviewRow(page, second)).toHaveAttribute("aria-selected", "true");
  await expect(reviewRow(page, first)).toHaveAttribute("aria-selected", "false");

  await page.keyboard.press("j");
  await expect(reviewRow(page, third)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("j");
  await expect(reviewRow(page, third)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("k");
  await expect(reviewRow(page, second)).toHaveAttribute("aria-selected", "true");
});

test("Space 로 선택하면 일괄 제외만 열린다 (일괄 승인 경로는 없다)", async ({ page }) => {
  await focusKeyboardSet(page);

  await expect(page.getByRole("button", { name: "선택 0건 제외" })).toBeDisabled();

  await page.keyboard.press(" ");
  await expect(page.getByLabel(`${first} 선택`)).toBeChecked();
  await expect(page.getByRole("button", { name: "선택 1건 제외" })).toBeEnabled();

  await page.keyboard.press("j");
  await page.keyboard.press(" ");
  await expect(page.getByLabel(`${second} 선택`)).toBeChecked();
  await expect(page.getByRole("button", { name: "선택 2건 제외" })).toBeEnabled();

  // ❗ 일괄 처리에 승인 경로가 없다 (설계서 §8.2 · API 도 bulk-decision 은 제외만 받는다).
  await expect(page.getByRole("button", { name: /선택 .*승인/ })).toHaveCount(0);
});

test("Enter 로 상세를 열고 e 로 이메일 입력에 바로 들어간다", async ({ page }) => {
  await focusKeyboardSet(page);

  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: `${first} 상세` });
  await expect(drawer).toBeVisible();
  // 상세(연락처 페이지 후보)가 도착할 때까지 기다린다 — 도착 전에는 입력이 잠겨 있다.
  // `<option>` 에도 같은 경로가 들어가므로 목록 항목으로 좁힌다.
  await expect(drawer.getByRole("listitem").getByText("/contact")).toBeVisible();

  await drawer.getByRole("button", { name: "닫기" }).click();
  await expect(drawer).toHaveCount(0);

  await page.keyboard.press("e");
  const reopened = page.getByRole("dialog", { name: `${first} 상세` });
  await expect(reopened).toBeVisible();
  await expect(reopened.getByLabel("업무용 이메일")).toBeFocused();
});

test("Esc 로 제외를 취소하면 아무것도 바뀌지 않는다", async ({ page }) => {
  await focusKeyboardSet(page);

  await page.keyboard.press("x");
  const dialog = page.getByRole("dialog", { name: "제외 사유 선택" });
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(reviewRow(page, first)).toBeVisible();
});

/**
 * ❗ 이 테스트는 행을 **실제로 제외한다.** 되돌릴 수 없으므로 파일에서 마지막에 둔다 —
 *    앞에 두면 뒤 테스트의 행 개수 가정이 깨진다 (실제로 한 번 깨졌다).
 */
test("x → 숫자키로 사유 선택 → Enter 로 제외가 서버에 반영된다", async ({ page }) => {
  await focusKeyboardSet(page);

  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(reviewRow(page, third)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("x");
  const dialog = page.getByRole("dialog", { name: "제외 사유 선택" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(third);

  // 사유는 필수다 — 기본값은 첫 항목이고 숫자키로 바꾼다.
  const radios = dialog.getByRole("radio");
  await expect(radios.nth(0)).toBeChecked();
  await page.keyboard.press("2");
  await expect(radios.nth(1)).toBeChecked();

  await page.keyboard.press("Enter");

  // ❗ 낙관적 갱신이 없다. 사라졌다는 것은 서버가 제외를 확인했다는 뜻이다.
  await expect(page.getByRole("row").filter({ hasText: third })).toHaveCount(0);

  // 사유와 cooldown 이 실제로 기록됐는지 본다 — 화면에서 사라진 것만으로는 부족하다.
  const rows = await sql<Array<{ status: string; reject_reason: string | null }>>`
    select ri.status, ri.reject_reason
    from review_items ri join companies c on c.id = ri.company_id
    where c.name = ${third}
  `;
  expect(rows[0]?.status).toBe("rejected");
  expect(rows[0]?.reject_reason).toBe("이미 마케팅 활발");
});
