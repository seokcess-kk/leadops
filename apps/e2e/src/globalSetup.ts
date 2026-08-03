import { createTestDb, createUser, isPostgresAvailable, DEFAULT_ADMIN_URL } from "@leadops/db";
import { API_PORT, JWT_SECRET, WEB_PORT, type E2EState } from "./env";
import { launch, killTree, REPO_ROOT, TAIMEN_DIR, waitForHttp, writeState } from "./harness";
import { seed } from "./seed";

/**
 * E2E 준비.
 *
 * 순서가 강제된다: 격리 DB 를 만들어야 DSN 이 생기고, 그 DSN 이 있어야 API 를 띄우고,
 * API 가 있어야 UI 가 게이트웨이로 프록시할 수 있다. Playwright 의 `webServer` 를 쓰지 않고
 * 직접 띄우는 이유가 이것이다 — `webServer` 는 globalSetup 이 만든 값을 받을 수 없다.
 *
 * ❗ 격리 데이터베이스를 쓴다. 개발용 DB 를 그대로 쓰면 E2E 가 승인 카운터·설정을 바꿔
 *    개발 중 화면이 조용히 달라진다.
 */
export default async function globalSetup(): Promise<void> {
  if (!(await isPostgresAvailable())) {
    throw new Error(
      "Postgres 에 접속할 수 없습니다. `pnpm db:up` 으로 컨테이너를 띄우세요.\n" +
        `  기대 주소: ${DEFAULT_ADMIN_URL}`,
    );
  }

  const db = await createTestDb("e2e");
  const dbUrl = new URL(DEFAULT_ADMIN_URL);
  dbUrl.pathname = `/${db.name}`;

  const reviewerEmail = "e2e-reviewer@example.kr";
  // admin 으로 만든다 — export·설정·비용이 admin 전용이고 E2E 가 그 경로를 통과해야 한다.
  const reviewerId = await createUser(db, reviewerEmail, "admin");
  await seed(db, reviewerId);

  const pids: number[] = [];
  const state: E2EState = {
    dbName: db.name,
    dbUrl: dbUrl.href,
    adminUrl: DEFAULT_ADMIN_URL,
    workerRole: `${db.name}_w`.slice(0, 60),
    reviewerId,
    reviewerEmail,
    pids,
  };

  const shared = {
    NODE_ENV: "development",
    FEATURE_SOURCE: "mock",
    FEATURE_ORS: "off",
    FEATURE_LLM: "off",
    HTTP_USER_AGENT: "LeadOpsE2E/1.0 (+https://example.kr/bot; contact@example.kr)",
    SUPABASE_JWT_SECRET: JWT_SECRET,
  };

  const api = launch(
    "pnpm",
    ["exec", "tsx", "apps/api/src/index.ts"],
    REPO_ROOT,
    { ...shared, API_DATABASE_URL: dbUrl.href, API_PORT: String(API_PORT) },
  );
  if (api.child.pid !== undefined) pids.push(api.child.pid);

  const web = launch(
    "pnpm",
    ["dev", "--port", String(WEB_PORT)],
    TAIMEN_DIR,
    {
      ...shared,
      NEXT_PUBLIC_LEADOPS_DATA_SOURCE: "api",
      LEADOPS_API_URL: `http://127.0.0.1:${API_PORT}`,
      // ⚠️ 개발·E2E 전용 인증 경로다. Supabase Auth(2026-07-31) 도입 때 삭제 대신 유지하기로
      //    결정 — E2E 가 실 Supabase 에 의존하지 않기 위한 격리 경로 (token.ts 참조).
      LEADOPS_DEV_LOGIN: "1",
      LEADOPS_DEV_USER_ID: reviewerId,
    },
  );
  if (web.child.pid !== undefined) pids.push(web.child.pid);

  // 상태를 먼저 쓴다 — 아래에서 실패해도 teardown 이 DB·프로세스를 정리할 수 있어야 한다.
  writeState(state);

  try {
    await waitForHttp(`http://127.0.0.1:${API_PORT}/health`, "검수 API", api);
    // ❗ 넉넉하게 기다린다. 이 요청이 `/today` 의 **첫 컴파일**을 촉발하는데, 캐시가 없는
    //    CI 러너에서는 Next 16 이 여기서 1분 이상 쓴다. 짧게 두면 "기동 실패" 로 오해한다.
    await waitForHttp(`http://localhost:${WEB_PORT}/today`, "taimen dev 서버", web, 300_000);
  } catch (err) {
    for (const pid of pids) killTree(pid);
    await db.close();
    const hint =
      "\n\n힌트: `taimen` 에서 이미 next dev 가 돌고 있으면 Next 가 두 번째 인스턴스를 거부합니다 " +
      "(포트가 달라도 디렉터리 단위 잠금입니다). 개발용 dev 서버를 먼저 끄세요.";
    throw new Error((err instanceof Error ? err.message : String(err)) + hint);
  }

  // 커넥션은 닫는다. 스펙은 자기 커넥션을 열고, teardown 은 이름으로 drop 한다.
  await db.owner.end({ timeout: 5 });
  await db.workerSql.end({ timeout: 5 });
}
