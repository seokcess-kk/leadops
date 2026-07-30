import { expect, test } from "@playwright/test";
import { NAMES } from "./seed";
import { failOnDialog, gotoTodayWith } from "./support";

/**
 * Phase 6 완료 기준 — XSS 페이로드 렌더링.
 *
 * ❗ 업체명·상호는 **공공 API 에서 온 외부 문자열**이다. 우리가 만든 값이 아니고, 검수자는
 *    그 문자열을 화면에서 읽는다. 마크업으로 해석되면 검수 화면이 임의 스크립트 실행 경로가
 *    되고, 그 화면에는 승인 권한과 (프록시 뒤의) 토큰이 걸려 있다.
 *
 * ❗ `dialog` 핸들러를 먼저 붙인다. Playwright 는 핸들러가 없으면 대화 상자를 자동으로
 *    닫아 버려서, 스크립트가 **실행됐는데도 테스트가 통과**한다.
 */
test("업체명의 XSS 페이로드는 텍스트로만 렌더링된다", async ({ page }) => {
  const dialogs = failOnDialog(page);

  await gotoTodayWith(page, NAMES.xss);
  // 페이로드가 **문자 그대로** 셀에 들어 있어야 한다 (잘리지 않은 textContent 기준).
  const cell = page.getByRole("cell", { name: NAMES.xss, exact: true });
  await expect(cell).toHaveCount(1);
  await expect(cell).toHaveText(NAMES.xss);

  // 주입된 태그가 실제 엘리먼트가 되었는지 본다 — 되었다면 DOM 에 노드가 생긴다.
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  await expect(page.locator("main script")).toHaveCount(0);

  // 상세 드로어에서도 같아야 한다. 제목은 aria-label 로도 들어간다.
  await page.getByRole("cell", { name: NAMES.xss, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: `${NAMES.xss} 상세` });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("img[src='x']")).toHaveCount(0);
  await expect(drawer.getByRole("heading", { name: NAMES.xss })).toBeVisible();

  expect(dialogs).toEqual([]);
});
