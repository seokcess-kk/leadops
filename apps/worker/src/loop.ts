import { LeadOpsError, type Logger } from "@leadops/core";
import { advanceAttempt, stageByName, type StageContext, type StageResult } from "@leadops/pipeline";
import type { SearchAdapter, SourceAdapter } from "@leadops/adapters";
import type { HttpClient, RobotsGate } from "@leadops/http";
import type { Sql } from "postgres";

/**
 * 잡 루프 (설계서 7.1 · F-15 · R2-24).
 *
 * 상태 전이는 전부 RPC 를 거친다. 워커에게는 `jobs` UPDATE 권한이 없다.
 *   acquire_job   — 원자적 획득 + fence_token 증가
 *   heartbeat_job — lease 연장. 0행이면 lease 를 빼앗긴 것이므로 **즉시 중단**
 *   complete_job  — 토큰이 맞을 때만 반영 (좀비 워커의 늦은 쓰기 차단)
 */

export interface AcquiredJob {
  job_id: string;
  fence_token: string;
  stage: string;
  payload: Record<string, unknown>;
}

export interface WorkerOptions {
  sql: Sql;
  logger: Logger;
  adapters: readonly SourceAdapter[];
  /**
   * 외부 사이트를 가져오는 스테이지(홈페이지 판별 이후)에 필요하다.
   * 주지 않으면 해당 스테이지는 `configuration_error` 로 실패한다 — 조용히 건너뛰지 않는다.
   */
  http?: HttpClient | undefined;
  robots?: RobotsGate | undefined;
  /** 검색 어댑터. `FEATURE_ORS=off` 면 없는 것이 정상이다. */
  search?: SearchAdapter | undefined;
  /** 이 워커의 식별자. 로그와 fencing 에 쓰인다. */
  workerId: string;
  leaseSeconds?: number;
  heartbeatMs?: number;
  /** 큐가 비었을 때 다음 폴링까지 대기. */
  idleMs?: number;
  /** 테스트에서 루프를 유한하게 만들기 위한 상한. */
  maxJobs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RunOneResult {
  job?: AcquiredJob;
  result?: StageResult;
  error?: string;
  /** complete_job 이 반영됐는지. false 면 lease 를 빼앗긴 것이다. */
  committed?: boolean;
}

export class Worker {
  readonly #sql: Sql;
  readonly #log: Logger;
  readonly #adapters: readonly SourceAdapter[];
  readonly #http: HttpClient | undefined;
  readonly #robots: RobotsGate | undefined;
  readonly #search: SearchAdapter | undefined;
  readonly #workerId: string;
  readonly #leaseSeconds: number;
  readonly #heartbeatMs: number;
  readonly #idleMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  #stopping = false;
  #processed = 0;

  constructor(options: WorkerOptions) {
    this.#sql = options.sql;
    this.#log = options.logger;
    this.#adapters = options.adapters;
    this.#http = options.http;
    this.#robots = options.robots;
    this.#search = options.search;
    this.#workerId = options.workerId;
    this.#leaseSeconds = options.leaseSeconds ?? 120;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#idleMs = options.idleMs ?? 2_000;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get processedCount(): number {
    return this.#processed;
  }

  /** 진행 중인 잡을 끝낸 뒤 멈춘다. 새 잡은 받지 않는다. */
  stop(): void {
    this.#stopping = true;
  }

  /** 잡 하나를 처리한다. 큐가 비었으면 `job` 없이 돌아온다. */
  async runOne(): Promise<RunOneResult> {
    const [job] = await this.#sql<AcquiredJob[]>`
      select * from public.acquire_job(${this.#workerId}, ${this.#leaseSeconds})
    `;
    if (!job) return {};

    const log = this.#log.child({ jobId: job.job_id, stage: job.stage, worker: this.#workerId });
    log.info("job.acquired", { fenceToken: job.fence_token });

    const heartbeat = setInterval(() => {
      void this.#heartbeat(job, log);
    }, this.#heartbeatMs);
    heartbeat.unref?.();

    try {
      const result = await this.#execute(job, log);
      const committed = await this.#complete(job, true, null);
      this.#processed++;
      log.info("job.succeeded", { ...result, committed });
      return { job, result, committed };
    } catch (err) {
      const message = err instanceof LeadOpsError ? `[${err.code}] ${err.message}` : (err as Error).message;
      const committed = await this.#complete(job, false, message);
      this.#processed++;
      log.warn("job.failed", { error: message, committed });
      return { job, error: message, committed };
    } finally {
      clearInterval(heartbeat);
      // 잡 하나가 끝날 때마다 DAG 를 전진시킨다 (다음 스테이지 enqueue · run 마감).
      try {
        await advanceAttempt(this.#sql, await this.#attemptIdOf(job.job_id), this.#log);
      } catch (err) {
        this.#log.error("advance.failed", { jobId: job.job_id, error: (err as Error).message });
      }
    }
  }

  /** 큐가 빌 때까지, 또는 stop() 될 때까지 계속 처리한다. */
  async run(maxJobs = Number.POSITIVE_INFINITY): Promise<number> {
    let handled = 0;
    while (!this.#stopping && handled < maxJobs) {
      const outcome = await this.runOne();
      if (!outcome.job) {
        if (this.#stopping) break;
        await this.#sleep(this.#idleMs);
        // 큐가 비었으면 한 번만 확인하고 나간다 (테스트·단발 실행용).
        if (maxJobs !== Number.POSITIVE_INFINITY) break;
        continue;
      }
      handled++;
    }
    return handled;
  }

  /** 큐가 빌 때까지만 처리하고 반환한다. 배치 실행·테스트용. */
  async drain(limit = 100): Promise<number> {
    let handled = 0;
    while (handled < limit) {
      const outcome = await this.runOne();
      if (!outcome.job) break;
      handled++;
    }
    return handled;
  }

  async #execute(job: AcquiredJob, log: Logger): Promise<StageResult> {
    const handler = stageByName(job.stage);
    const attemptId = await this.#attemptIdOf(job.job_id);

    const [row] = await this.#sql<
      Array<{ run_id: string; run_date: string; settings_snapshot: Record<string, unknown> }>
    >`
      select r.id as run_id, r.run_date::text as run_date, r.settings_snapshot
      from run_attempts a join runs r on r.id = a.run_id
      where a.id = ${attemptId}
    `;
    if (!row) throw new LeadOpsError("not_found", `실행을 찾을 수 없습니다: ${attemptId}`);

    const ctx: StageContext = {
      sql: this.#sql,
      runId: row.run_id,
      runDate: row.run_date,
      attemptId,
      settings: row.settings_snapshot,
      logger: log,
      adapters: this.#adapters,
      http: this.#http,
      robots: this.#robots,
      search: this.#search,
    };
    return handler.run(ctx, job.payload);
  }

  async #heartbeat(job: AcquiredJob, log: Logger): Promise<void> {
    try {
      const [row] = await this.#sql<Array<{ heartbeat_job: boolean }>>`
        select public.heartbeat_job(
          ${job.job_id}::bigint, ${job.fence_token}::bigint, ${this.#workerId}, ${this.#leaseSeconds})
      `;
      if (!row?.heartbeat_job) {
        // lease 를 빼앗겼다. 우리 결과는 어차피 fencing 에 막히므로 알리기만 한다.
        log.warn("job.lease_lost", { note: "다른 워커가 이 잡을 가져갔습니다. 결과는 반영되지 않습니다." });
      }
    } catch (err) {
      log.warn("job.heartbeat_error", { error: (err as Error).message });
    }
  }

  async #complete(job: AcquiredJob, success: boolean, error: string | null): Promise<boolean> {
    const [row] = await this.#sql<Array<{ complete_job: boolean }>>`
      select public.complete_job(
        ${job.job_id}::bigint, ${job.fence_token}::bigint, ${this.#workerId}, ${success}, ${error})
    `;
    return row?.complete_job ?? false;
  }

  async #attemptIdOf(jobId: string): Promise<string> {
    const [row] = await this.#sql<Array<{ attempt_id: string }>>`
      select attempt_id from jobs where id = ${jobId}
    `;
    if (!row) throw new LeadOpsError("not_found", `잡을 찾을 수 없습니다: ${jobId}`);
    return row.attempt_id;
  }
}
