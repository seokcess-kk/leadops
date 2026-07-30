#!/usr/bin/env node
import { hostname } from "node:os";
import { createSearchAdapter, createSourceAdapters } from "@leadops/adapters";
import { configError, createLogger, getEnv, Industry, LeadOpsError, type Industry as IndustryT } from "@leadops/core";
import { createHttpClient, RobotsGate, userAgentToken } from "@leadops/http";
import { startRun } from "@leadops/pipeline";
import postgres from "postgres";
import { Worker } from "./loop";

/**
 * 워커 엔트리포인트.
 *
 * 두 가지 모드:
 *   worker           큐를 계속 비운다 (상시 실행)
 *   run <industries> 새 실행을 만들고 큐에 넣은 뒤, 큐가 빌 때까지 처리한다
 *
 * ❗ DB 접속은 **워커 전용 최소권한 역할**(`leadops_worker`)로 한다.
 *    Supabase 의 `service_role` 키는 PostgREST 용 JWT 이지 DB 비밀번호가 아니다(F-14).
 */

const HELP = `
LeadOps 워커

사용법:
  pnpm worker <command> [options]

명령:
  worker              큐를 계속 비운다 (Ctrl+C 로 안전 종료)
  run                 새 실행을 만들고 끝까지 처리한다
  schedule            스케줄 판정 후 조건이 맞으면 cron 실행을 만든다
  reap                만료된 lease 를 회수한다 (cron 으로 1분마다)
  cleanup             보존기간이 지난 데이터를 정리한다 (용량 인식)
  capacity            DB 용량과 임계 레벨을 출력한다

옵션:
  --industry <a,b>    대상 업종 (기본: 전체)
  --limit <n>         업종당 수집 상한 (기본 500)
  --max-jobs <n>      처리할 잡 수 상한
  --dry-run           schedule: 판정만 하고 실행하지 않는다
  --log <level>       debug|info|warn|error

환경변수:
  WORKER_DATABASE_URL   leadops_worker 역할로 접속할 DSN (필수)
`;

interface Args {
  command?: string | undefined;
  flags: Record<string, string | boolean>;
}

function parse(argv: readonly string[]): Args {
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      command ??= token;
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    }
  }
  return { command, flags };
}

function parseIndustries(raw: unknown): readonly IndustryT[] {
  if (typeof raw !== "string" || raw.trim() === "") return Industry.options as readonly IndustryT[];
  return raw.split(",").map((s) => {
    const parsed = Industry.safeParse(s.trim());
    if (!parsed.success) throw configError(`알 수 없는 업종: ${s} (가능: ${Industry.options.join(", ")})`);
    return parsed.data;
  });
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (!args.command || args.command === "help" || args.flags["help"] === true) {
    process.stdout.write(HELP);
    return 0;
  }

  const env = getEnv();
  const level = (typeof args.flags["log"] === "string" ? args.flags["log"] : "info") as
    | "debug" | "info" | "warn" | "error";
  const logger = createLogger({ level, sink: (line) => process.stderr.write(line + "\n") });

  const dsn = process.env["WORKER_DATABASE_URL"];
  if (!dsn) {
    throw configError(
      "WORKER_DATABASE_URL 이 필요합니다.\n" +
        "  leadops_worker 역할로 접속하는 DSN 을 넣으세요.\n" +
        "  예: postgres://leadops_worker:<pw>@host:5432/leadops",
    );
  }

  const sql = postgres(dsn, { max: 4, onnotice: () => {} });
  const http = createHttpClient(env, { logger });
  const adapters = createSourceAdapters(env, http);
  const robots = new RobotsGate({
    client: http,
    userAgentToken: userAgentToken(env.HTTP_USER_AGENT),
    logger,
  });

  const workerId = `${hostname()}:${process.pid}`;
  const search = createSearchAdapter(env, http);
  if (!search) {
    logger.info("ors.disabled", {
      note: "FEATURE_ORS=off — 검색 분석 없이 채널 활성도 중심 축소 파이프라인으로 동작합니다.",
    });
  }
  const worker = new Worker({ sql, logger, adapters, http, robots, search, workerId });

  // 안전 종료: 진행 중인 잡을 끝낸 뒤 멈춘다. 강제 종료는 lease 만료로 reaper 가 회수한다.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("worker.shutdown", { signal, note: "진행 중인 잡을 마친 뒤 종료합니다" });
    worker.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    switch (args.command) {
      case "worker": {
        const maxJobs = typeof args.flags["max-jobs"] === "string" ? Number(args.flags["max-jobs"]) : undefined;
        logger.info("worker.started", { workerId, maxJobs: maxJobs ?? "무제한" });
        const handled = await worker.run(maxJobs ?? Number.POSITIVE_INFINITY);
        logger.info("worker.stopped", { handled });
        return 0;
      }
      case "run": {
        const industries = parseIndustries(args.flags["industry"]);
        const limit = typeof args.flags["limit"] === "string" ? Number(args.flags["limit"]) : 500;
        const started = await startRun(sql, {
          trigger: "manual",
          industries,
          perIndustryLimit: limit,
          logger,
        });
        const handled = await worker.drain(500);
        const [run] = await sql<Array<{ status: string; counts: unknown }>>`
          select status, counts from runs where id = ${started.runId}
        `;
        process.stdout.write(
          `\n실행 ${started.runId}\n  잡 ${handled}개 처리\n  상태: ${run?.status ?? "?"}\n\n`,
        );
        return run?.status === "failed" ? 1 : 0;
      }
      /**
       * 스케줄 판정 → 실행.
       *
       * ❗ 운영에서는 pg_cron 이 `POST /internal/run` 을 부른다. 이 명령은 **같은 판정 함수**
       *    (`should_start_scheduled_run`)를 쓰는 로컬·수동 경로다 — 판정 규칙이 DB 한 곳에만
       *    있으므로 두 경로가 갈라지지 않는다.
       */
      case "schedule": {
        const [row] = await sql<Array<{ d: { should_run: boolean; run_date: string; reasons: string[] } }>>`
          select public.should_start_scheduled_run() as d
        `;
        const decision = row!.d;
        if (!decision.should_run) {
          logger.info("schedule.skipped", { reasons: decision.reasons, runDate: decision.run_date });
          process.stdout.write(`\n건너뜀: ${decision.reasons.join(", ")}\n\n`);
          return 0;
        }
        if (args.flags["dry-run"] === true) {
          process.stdout.write(`\n실행 조건 충족 (run_date ${decision.run_date}). --dry-run 이라 만들지 않습니다.\n\n`);
          return 0;
        }
        const industries = parseIndustries(args.flags["industry"]);
        const limit = typeof args.flags["limit"] === "string" ? Number(args.flags["limit"]) : 500;
        const started = await startRun(sql, {
          trigger: "cron",
          runDate: decision.run_date,
          industries,
          perIndustryLimit: limit,
          logger,
        });
        process.stdout.write(`\ncron 실행 ${started.runId} 생성 (run_date ${decision.run_date})\n\n`);
        return 0;
      }
      case "reap": {
        const [row] = await sql<Array<{ reap_expired_jobs: number }>>`select public.reap_expired_jobs()`;
        logger.info("reap.done", { requeued: row?.reap_expired_jobs ?? 0 });
        return 0;
      }
      case "cleanup": {
        // ❗ 용량 인식 정리. 평시에는 기본 보존기간만 적용하고, 85% 이상에서만 공격적으로
        //    줄인다 — 평시에 공격적으로 지우면 회귀 입력과 감사 추적이 사라진다.
        const [row] = await sql<Array<{ cleanup_by_capacity: Record<string, unknown> }>>`
          select public.cleanup_by_capacity()
        `;
        logger.info("cleanup.done", row?.cleanup_by_capacity ?? {});
        process.stdout.write(`\n${JSON.stringify(row?.cleanup_by_capacity ?? {}, null, 2)}\n\n`);
        return 0;
      }
      case "capacity": {
        const [row] = await sql<Array<{ db_capacity: Record<string, unknown> }>>`select public.db_capacity()`;
        const cap = row!.db_capacity;
        const level = String(cap["level"]);
        process.stdout.write(
          `\nDB 용량 ${cap["pct"]}%  (${cap["bytes"]} / ${cap["limit_bytes"]} bytes)  레벨: ${level}\n` +
            (level === "ok"
              ? "\n"
              : level === "warn"
                ? "  ⚠ 70% 초과 — 보존기간·이전 계획을 점검하세요.\n\n"
                : level === "cleanup"
                  ? "  ⚠ 85% 초과 — 정리 잡이 보존기간을 줄입니다 (pnpm worker cleanup).\n\n"
                  : "  ✗ 90% 초과 — 신규 실행이 차단됩니다.\n\n"),
        );
        // ❗ 차단 레벨은 종료 코드로도 알린다. 모니터링이 stdout 을 파싱하게 만들지 않는다.
        return level === "block" ? 1 : 0;
      }
      default:
        process.stderr.write(`알 수 없는 명령: ${args.command}\n${HELP}`);
        return 2;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof LeadOpsError) {
      process.stderr.write(`\n✗ [${err.code}] ${err.message}\n`);
    } else {
      process.stderr.write(`\n✗ ${(err as Error).message}\n`);
    }
    process.exitCode = 1;
  });
