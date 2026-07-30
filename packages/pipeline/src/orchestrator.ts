import { configError, Industry, type Logger } from "@leadops/core";
import type { Sql } from "postgres";
import { collectPayloads } from "./stages/collect";
import { STAGES, stageOrder } from "./stages/index";

/**
 * 실행 오케스트레이션 (설계서 5.3 · 7.1).
 *
 * 잡 큐에는 의존 관계 개념이 없다. 그래서 **선행 스테이지가 terminal 이 됐을 때
 * 다음 스테이지를 enqueue** 하는 방식으로 DAG 를 만든다.
 * 모든 잡을 미리 넣고 각자 폴링하게 하면 큐가 헛돌기 때문이다.
 */

export type StageStatus = "pending" | "running" | "succeeded" | "partial" | "failed" | "skipped";

/** terminal = 더 이상 상태가 바뀌지 않는 상태. 다음 스테이지를 열어도 된다. */
export function isTerminal(status: StageStatus): boolean {
  return status === "succeeded" || status === "partial" || status === "failed" || status === "skipped";
}

/**
 * 잡 집계에서 스테이지 상태를 계산한다 (설계서 5.3 `partial` 집계 SQL).
 *
 * `partial` 은 일부가 죽었지만 다운스트림을 진행할 만한 상태다.
 * **성공으로 위장하지 않는다** — 이름이 다르고 리포트에 그대로 나온다.
 */
export function deriveStageStatus(total: number, done: number, failed: number): StageStatus {
  if (total === 0) return "pending";
  if (done + failed < total) return "running";
  if (failed === 0) return "succeeded";
  if (done >= total * 0.8) return "partial";
  return "failed";
}

export interface StartRunOptions {
  trigger: "cron" | "manual" | "retry";
  runDate?: string;
  industries: readonly Industry[];
  /** 업종당 수집 상한. */
  perIndustryLimit: number;
  logger: Logger;
}

export interface StartedRun {
  runId: string;
  attemptId: string;
}

/** 실행을 만들고 첫 스테이지를 enqueue 한다. 설정은 이 시점에 동결된다. */
export async function startRun(sql: Sql, options: StartRunOptions): Promise<StartedRun> {
  if (options.industries.length === 0) {
    throw configError("업종을 하나 이상 지정해야 합니다");
  }

  // ❗ 용량 게이트를 **실행을 만들기 전에** 통과한다 (설계서 4.2 · 90% 도달 시 차단).
  //    꽉 찬 뒤에 멈추면 그 순간의 쓰기가 실패하면서 중간 상태가 남는다. 여기서 던지는
  //    `capacity_exceeded` 는 조용히 삼키지 않는다 — 실행이 안 만들어졌다는 사실이 알려져야 한다.
  const [capacity] = await sql<Array<{ assert_capacity_for_run: Record<string, unknown> }>>`
    select public.assert_capacity_for_run()
  `;
  const level = capacity?.assert_capacity_for_run?.["level"];
  if (level === "warn" || level === "cleanup") {
    options.logger.warn("capacity.pressure", capacity?.assert_capacity_for_run ?? {});
  }

  const runDate = options.runDate ?? new Date().toISOString().slice(0, 10);

  const started = await sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      insert into runs (run_date, trigger, status, settings_snapshot, started_at)
      values (${runDate}::date, ${options.trigger}, 'running', public.snapshot_settings(), now())
      returning id
    `;
    const [attempt] = await tx<{ id: string }[]>`
      insert into run_attempts (run_id, attempt_no) values (${run!.id}, 1) returning id
    `;

    // 스테이지 행을 미리 만들어 둔다. 진행 화면이 "아직 시작 안 함" 을 보여줄 수 있어야 한다.
    for (const stage of stageOrder()) {
      await tx`
        insert into run_stages (attempt_id, stage, status) values (${attempt!.id}, ${stage}, 'pending')
        on conflict (attempt_id, stage) do nothing
      `;
    }
    return { runId: run!.id, attemptId: attempt!.id };
  });

  await enqueueStage(sql, started.attemptId, "collect", {
    industries: options.industries,
    perIndustryLimit: options.perIndustryLimit,
  });

  options.logger.info("run.started", {
    runId: started.runId,
    attemptId: started.attemptId,
    industries: options.industries,
  });
  return started;
}

interface EnqueueOptions {
  industries?: readonly Industry[];
  perIndustryLimit?: number;
}

/** 스테이지의 잡들을 enqueue 한다. 멱등하다 (`unique (attempt_id, stage, idempotency_key)`). */
export async function enqueueStage(
  sql: Sql,
  attemptId: string,
  stage: string,
  options: EnqueueOptions = {},
): Promise<number> {
  const jobs =
    stage === "collect"
      ? collectPayloads(options.industries ?? [], options.perIndustryLimit ?? 500)
      : [{ idempotencyKey: `${stage}:all`, payload: {} }];

  let inserted = 0;
  for (const job of jobs) {
    const rows = await sql<{ id: string }[]>`
      insert into jobs (attempt_id, stage, idempotency_key, payload)
      values (${attemptId}, ${stage}, ${job.idempotencyKey}, ${sql.json(job.payload as Record<string, string | number | boolean>)})
      on conflict (attempt_id, stage, idempotency_key) do nothing
      returning id
    `;
    inserted += rows.length;
  }

  await sql`
    update run_stages set total = total + ${inserted}, status = 'running', started_at = coalesce(started_at, now())
    where attempt_id = ${attemptId} and stage = ${stage}
  `;
  return inserted;
}

export interface AttemptProgress {
  stages: Array<{ stage: string; status: StageStatus; total: number; done: number; failed: number }>;
  runStatus: "running" | "succeeded" | "partial" | "failed";
}

/**
 * 잡 상태를 집계해 스테이지·실행 상태를 갱신하고, 열 수 있는 다음 스테이지를 enqueue 한다.
 *
 * 워커가 잡 하나를 끝낼 때마다 호출한다. 멱등하므로 여러 워커가 동시에 불러도 안전하다.
 */
export async function advanceAttempt(sql: Sql, attemptId: string, logger: Logger): Promise<AttemptProgress> {
  const counts = await sql<Array<{ stage: string; total: string; done: string; failed: string }>>`
    select stage,
           count(*)::text as total,
           count(*) filter (where status = 'succeeded')::text as done,
           count(*) filter (where status = 'dead')::text as failed
    from jobs where attempt_id = ${attemptId}
    group by stage
  `;
  const byStage = new Map(counts.map((c) => [c.stage, c]));

  const progress: AttemptProgress["stages"] = [];
  for (const stage of stageOrder()) {
    const c = byStage.get(stage);
    const total = Number(c?.total ?? 0);
    const done = Number(c?.done ?? 0);
    const failed = Number(c?.failed ?? 0);
    const status = deriveStageStatus(total, done, failed);
    progress.push({ stage, status, total, done, failed });

    if (total > 0) {
      await sql`
        update run_stages
        set status = ${status}, total = ${total}, done = ${done}, failed = ${failed},
            finished_at = case when ${isTerminal(status)} then coalesce(finished_at, now()) else null end
        where attempt_id = ${attemptId} and stage = ${stage}
      `;
    }
  }

  // 선행 스테이지가 전부 terminal 이면 다음 스테이지를 연다.
  const statusOf = new Map(progress.map((p) => [p.stage, p]));
  for (const handler of STAGES) {
    const self = statusOf.get(handler.stage)!;
    if (self.total > 0) continue; // 이미 enqueue 됨
    const depsReady = handler.dependsOn.every((d) => isTerminal(statusOf.get(d)?.status ?? "pending"));
    if (!depsReady) continue;
    // 선행이 전부 failed 면 열지 않는다. 입력이 없는데 도는 것은 낭비다.
    const depsAllFailed =
      handler.dependsOn.length > 0 && handler.dependsOn.every((d) => statusOf.get(d)?.status === "failed");
    if (depsAllFailed) {
      await sql`
        update run_stages set status = 'skipped', finished_at = now()
        where attempt_id = ${attemptId} and stage = ${handler.stage}
      `;
      logger.warn("stage.skipped", { stage: handler.stage, reason: "선행 스테이지가 모두 실패" });
      continue;
    }
    const n = await enqueueStage(sql, attemptId, handler.stage);
    if (n > 0) logger.info("stage.enqueued", { stage: handler.stage, jobs: n });
  }

  // 전부 terminal 이면 실행을 마감한다.
  const allTerminal = progress.every((p) => p.total > 0 && isTerminal(p.status));
  let runStatus: AttemptProgress["runStatus"] = "running";
  if (allTerminal) {
    runStatus = progress.some((p) => p.status === "failed")
      ? "failed"
      : progress.some((p) => p.status === "partial")
        ? "partial"
        : "succeeded";
    await sql`
      update runs set status = ${runStatus}, finished_at = now()
      where id = (select run_id from run_attempts where id = ${attemptId})
        and status not in ('cancelled', 'paused')
    `;
    logger.info("run.finished", { attemptId, status: runStatus });
  }

  return { stages: progress, runStatus };
}
