import { createCandidate, createRun, createVerifiedEmail, type TestDb } from "@leadops/db";
import type { Sql } from "postgres";

/**
 * E2E fixture.
 *
 * ❗ 파이프라인을 돌려서 후보를 만들지 않는다. mock 어댑터의 홈페이지 도메인은 실제로
 *    존재하지 않아 공식 판정이 0 이고, 그러면 게이트를 통과하는 후보가 하나도 없다
 *    (콜드 스타트 · `competitor_gap_unavailable`). 검수 화면을 검증하려면 **검수 후보가
 *    있는 상태**가 필요하므로 통합 테스트와 같은 fixture 로 직접 만든다.
 *
 * ❗ 스펙마다 **자기 후보**를 쓴다. 승인은 되돌릴 수 없으므로(review_items 가 pending 을
 *    벗어난다) 후보를 공유하면 실행 순서에 따라 결과가 달라진다.
 */

/** 스펙이 행을 찾을 때 쓰는 이름. 화면에 그대로 보인다. */
export const NAMES = {
  /** 이메일을 UI 로 직접 입력해 승인까지 가는 후보 (연락처 페이지 있음 · 이메일 없음). */
  happyPath: "E2E해피패스치과",
  /** 일 상한 검증 — 이미 MX 통과 이메일이 있어 화면에서 승인만 누르면 된다. */
  dailyCap: ["E2E일상한1성형외과", "E2E일상한2성형외과"],
  /** 업종 쿼터 검증 — 같은 업종이어야 쿼터가 걸린다. */
  industryQuota: ["E2E업종쿼터1프랜차이즈", "E2E업종쿼터2프랜차이즈"],
  /**
   * XSS 페이로드가 **텍스트로** 렌더링되는지 본다.
   *
   * ❗ 업체명은 공공 API 에서 온 외부 문자열이다. 이 값이 마크업으로 해석되면 검수 화면이
   *    임의 스크립트 실행 경로가 된다.
   */
  xss: `E2E<img src=x onerror="window.__xss=1">"'&<script>window.__xss=2</script>주사`,
  /** 키보드 조작 — 커서 이동을 확인하려면 순서가 고정된 여러 행이 필요하다. */
  keyboard: ["E2E키보드1의원", "E2E키보드2의원", "E2E키보드3의원"],
} as const;

export interface SeedResult {
  reviewerId: string;
  /** 승인 대상 후보의 이름 → review_items.id */
  itemIds: Record<string, string>;
}

export async function seed(db: TestDb, reviewerId: string): Promise<SeedResult> {
  // 후보 전체를 한 실행에 묶는다 — 실행 이력 화면도 실데이터를 보게 된다.
  const { runId, attemptId } = await createRun(db);
  const itemIds: Record<string, string> = {};

  let rank = 1;
  const add = async (name: string, industry: string, withEmail: boolean): Promise<void> => {
    const candidate = await createCandidate(db, { name, industry, rank: rank++, runId, attemptId });
    if (withEmail) {
      // 화면이 승인만 누르면 되는 상태. MX 통과 이메일은 fixture 가 직접 만든다 —
      // 상한·쿼터를 검증하려는 것이고 이메일 입력 경로는 해피패스에서 이미 본다.
      await createVerifiedEmail(db, candidate, reviewerId);
    }
    itemIds[name] = candidate.reviewItemId;
  };

  await add(NAMES.happyPath, "dental", false);
  for (const name of NAMES.dailyCap) await add(name, "plastic", true);
  for (const name of NAMES.industryQuota) await add(name, "franchise", true);
  await add(NAMES.xss, "dental", false);
  for (const name of NAMES.keyboard) await add(name, "dental", false);

  return { reviewerId, itemIds };
}

/**
 * 승인 카운터와 리드를 지운다.
 *
 * ❗ 카운터는 **승인일 기준**이라 같은 날 실행되는 스펙들이 서로의 숫자를 물려받는다.
 *    상한 검증은 "상한에 닿는 순간"을 봐야 하므로 각 스펙이 0 에서 시작해야 한다.
 *    게이트 자체를 끄는 것이 아니다 — 검증 중에는 그대로 강제된다.
 */
export async function resetApprovalState(sql: Sql): Promise<void> {
  await sql`delete from leads`;
  await sql`delete from approval_counters`;
  await sql`delete from approval_day_totals`;
}

/** 설정 한 키를 통째로 바꾼다 (fixture 준비용 — 화면 경로는 PUT /api/settings 를 쓴다). */
export async function putSetting(sql: Sql, key: string, value: Record<string, unknown>): Promise<void> {
  // JSON.parse 를 통과한 값이므로 직렬화 가능하다. 타입만 좁혀 준다.
  const json = value as Parameters<typeof sql.json>[0];
  await sql`
    insert into settings (key, value) values (${key}, ${sql.json(json)})
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

/**
 * 실행의 **동결 스냅샷**을 바꾼다.
 *
 * ❗ `decide_review_item` 은 일 상한·업종 쿼터를 live `settings` 가 아니라
 *    `runs.settings_snapshot` 에서 읽는다 (마이그레이션 0004 · R2-19). 설계 의도다 —
 *    실행 도중 상한을 바꿔도 그 실행의 판정 기준은 흔들리지 않는다.
 *    그래서 상한을 검증하려면 **스냅샷**을 바꿔야 한다. live 설정만 바꾸면 아무 일도 안 난다.
 */
export async function putRunTargets(sql: Sql, targets: Record<string, unknown>): Promise<void> {
  const json = targets as Parameters<typeof sql.json>[0];
  await sql`update runs set settings_snapshot = jsonb_set(settings_snapshot, '{targets}', ${sql.json(json)})`;
}

export async function getSetting(sql: Sql, key: string): Promise<Record<string, unknown>> {
  const rows = await sql<Array<{ value: Record<string, unknown> }>>`
    select value from settings where key = ${key}
  `;
  const value = rows[0]?.value;
  if (value === undefined) throw new Error(`설정 키가 없습니다: ${key}`);
  return value;
}
