import { expect, type Locator, type Page } from "@playwright/test";
import postgres, { type Sql } from "postgres";
import { readState } from "./harness";

/** 격리 DB 소유자 커넥션. fixture 상태 준비·사후 확인에 쓴다. */
export function ownerSql(): Sql {
  return postgres(readState().dbUrl, { max: 2, onnotice: () => {} });
}

/** 검수 목록의 한 행. 업체명으로 찾는다 — 화면에 보이는 것으로 찾아야 화면을 검증한 것이다. */
export function reviewRow(page: Page, companyName: string): Locator {
  return page.getByRole("row").filter({ hasText: companyName });
}

/**
 * 목록에서 그 행이 보일 때까지 기다린다.
 *
 * ❗ 목록은 클라이언트가 API 를 읽어 그린다. `goto` 직후에는 비어 있으므로 행을 기다려야
 *    한다 — 여기서 기다리지 않으면 "행 없음" 을 진짜 결과로 오해한다.
 */
export async function gotoTodayWith(page: Page, companyName: string): Promise<Locator> {
  await page.goto("/today");
  const row = reviewRow(page, companyName);
  await expect(row).toBeVisible();
  return row;
}

/** 화면에 뜬 서버 거절 사유. `Notice` 는 코드와 문구를 함께 보여 준다. */
export function notice(page: Page, code: string): Locator {
  return page.locator("[role=alert], [role=status]").filter({ hasText: code });
}

/**
 * 대화 상자가 뜨면 즉시 실패한다.
 *
 * ❗ XSS 페이로드가 실행되면 `alert` 가 뜬다. 핸들러를 붙여 두지 않으면 Playwright 가
 *    자동으로 닫아 버려 **테스트가 조용히 통과한다** — 검증하려던 것이 사라진다.
 */
export function failOnDialog(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (dialog) => {
    seen.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return seen;
}
