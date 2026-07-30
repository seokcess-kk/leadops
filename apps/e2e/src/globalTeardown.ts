import postgres from "postgres";
import { clearState, killTree, readState } from "./harness";

/**
 * E2E 정리.
 *
 * ❗ 반드시 **역할까지** 지운다. 데이터베이스는 실행마다 새로 만들지만 `createTestDb` 가
 *    만드는 워커 로그인 역할은 **클러스터 전역**이라, 남기면 실행할수록 역할이 쌓인다.
 *
 * ❗ 프로세스를 먼저 죽인다. 커넥션이 남아 있으면 `drop database` 가 막힌다
 *    (`with (force)` 로도 경합이 생긴다).
 */
export default async function globalTeardown(): Promise<void> {
  let state;
  try {
    state = readState();
  } catch {
    // setup 이 상태를 쓰기 전에 실패했다 — 지울 것이 없다.
    return;
  }

  for (const pid of state.pids) killTree(pid);

  const admin = postgres(state.adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${state.dbName}" with (force)`);
    await admin.unsafe(`drop role if exists "${state.workerRole}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  clearState();
}
