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
 *   API_DATABASE_URL      권한 있는 DSN (필수)
 *   SUPABASE_JWT_SECRET   Supabase 프로젝트의 JWT Secret (필수)
 *   API_PORT              기본 8787
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

  const sql = postgres(dsn, { max: 8, onnotice: () => {} });
  const server = createApi({ sql, jwtSecret, logger });

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
