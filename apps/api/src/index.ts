#!/usr/bin/env node
import { createLogger, getEnv, LeadOpsError } from "@leadops/core";
import postgres from "postgres";
import { createApi } from "./server";

/**
 * 검수 API 엔트리포인트.
 *
 * ❗ DB 접속은 권한 있는 역할로 하고, 사용자 작업마다 트랜잭션 안에서 `authenticated` 로
 *    내려간다 (`session.ts`). 그렇게 해야 RLS 가 적용된 상태로 질의된다.
 *
 * 환경변수:
 *   API_DATABASE_URL         권한 있는 DSN (필수)
 *   SUPABASE_JWT_SECRET      Supabase 프로젝트의 JWT Secret (필수 — dev login·E2E 의 HS256 경로)
 *   SUPABASE_JWT_PUBLIC_JWK  Supabase 사용자 토큰(ES256) 공개키 — JWKS 의 키 JSON 한 줄.
 *                            없으면 ES256 토큰이 전부 401 (Supabase 실로그인 불가).
 *   API_PORT                 기본 8787
 *   INTERNAL_TRIGGER_SECRET  pg_cron → `POST /internal/run` 서명 비밀 (32자 이상)
 *                            없으면 그 경로가 비활성이다 (401). 조용히 열리지 않는다.
 */

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new LeadOpsError("config_error", `${name} 이 필요합니다.\n  ${hint}`);
  return value;
}

async function main(): Promise<void> {
  const env = getEnv();
  const logger = createLogger({
    level: (process.env["LOG_LEVEL"] as "debug" | "info" | "warn" | "error") ?? "info",
    sink: (line) => process.stderr.write(line + "\n"),
  });

  const dsn = required("API_DATABASE_URL", "예: postgres://postgres:<pw>@host:5432/leadops");
  const jwtSecret = required("SUPABASE_JWT_SECRET", "Supabase 대시보드 → Settings → API → JWT Secret");
  const port = Number(process.env["API_PORT"] ?? 8787);

  const jwtPublicJwk = process.env["SUPABASE_JWT_PUBLIC_JWK"];
  if (!jwtPublicJwk) {
    // 부팅을 막지 않는다 — 로컬 dev·E2E 는 HS256 만 쓴다. 다만 Supabase 실로그인이
    // 필요한 구성에서 이 경고를 놓치면 모든 사용자 요청이 401 이므로, 로그에 남긴다.
    logger.warn("jwt.es256_disabled", {
      note: "SUPABASE_JWT_PUBLIC_JWK 이 없어 ES256 사용자 토큰을 전부 거절합니다 (JWKS: <SUPABASE_URL>/auth/v1/.well-known/jwks.json).",
    });
  }

  const internalSecret = process.env["INTERNAL_TRIGGER_SECRET"];
  if (!internalSecret) {
    // 부팅을 막지 않는다 — 스케줄러 없이 검수만 운영하는 구성이 정당하다. 다만 조용히
    // 넘기지도 않는다: 그 경로가 꺼져 있다는 사실이 로그에 남아야 한다.
    logger.warn("internal.trigger_disabled", {
      note: "INTERNAL_TRIGGER_SECRET 이 없어 POST /internal/run 이 401 을 돌려줍니다 (pg_cron 스케줄 비활성).",
    });
  }

  const sql = postgres(dsn, { max: 8, onnotice: () => {} });
  const server = createApi({ sql, jwtSecret, jwtPublicJwk, logger, internalSecret });

  const shutdown = (signal: string): void => {
    logger.info("api.shutdown", { signal });
    server.close(() => {
      void sql.end({ timeout: 5 }).then(() => process.exit(0));
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(port, () => {
    logger.info("api.started", { port, ors: env.FEATURE_ORS });
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
