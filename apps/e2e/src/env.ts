import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E 실행 파라미터.
 *
 * ❗ 포트를 개발 기본값(3000·8787)과 다르게 둔다. 개발 중인 서버를 E2E 가 붙잡거나
 *    반대로 E2E 서버를 개발용으로 오인해 쓰는 일을 막는다.
 */
export const API_PORT = 8799;
export const WEB_PORT = 3199;
export const BASE_URL = `http://localhost:${WEB_PORT}`;

/**
 * 개발용 서버 토큰 서명 키.
 *
 * ❗ 로컬 검증 전용이다. `taimen` 의 `sessionToken()` 은 `NODE_ENV=production` 이면
 *    이 경로를 거부하므로 (`src/lib/server/token.ts`) 배포에 새어 나갈 수 없다.
 */
export const JWT_SECRET = "leadops-e2e-jwt-secret-not-a-real-secret";

/**
 * MX 가 실제로 조회되는 도메인.
 *
 * ❗ 여기서 **DNS 를 흉내 내지 않는다.** MX 검증은 승인 게이트의 핵심이고, 가짜 리졸버로
 *    통과시키면 그 게이트를 검증한 것이 아니다 (설계서가 실제 Postgres 를 쓰는 이유와 같다).
 *    그래서 E2E 는 네트워크가 필요하다 — 이것은 결함이 아니라 선택이다.
 */
export const MX_DOMAIN = process.env["LEADOPS_E2E_MX_DOMAIN"] ?? "naver.com";

/** 예약 TLD. 등록될 수 없으므로 "해석되지 않는 도메인" 이 영구히 보장된다 (RFC 2606). */
export const UNRESOLVABLE_DOMAIN = "leadops-e2e-nope.example";

/** globalSetup → 스펙 → globalTeardown 사이에 상태를 넘긴다 (모듈 인스턴스가 다르다). */
export const STATE_FILE = join(tmpdir(), "leadops-e2e-state.json");

export interface E2EState {
  /** 격리 데이터베이스 이름. teardown 이 drop 한다. */
  dbName: string;
  /** 소유자 자격으로 격리 DB 에 붙는 DSN. 스펙이 fixture 상태를 초기화할 때 쓴다. */
  dbUrl: string;
  /** 클러스터 관리 DSN. drop database 에 쓴다. */
  adminUrl: string;
  /** `createTestDb` 가 만든 워커 전용 로그인 역할. 역할은 클러스터 전역이라 반드시 지운다. */
  workerRole: string;
  reviewerId: string;
  reviewerEmail: string;
  /** 죽여야 할 자식 프로세스 (API · Next). */
  pids: number[];
}
