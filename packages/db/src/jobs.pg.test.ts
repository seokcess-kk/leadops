import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRun } from "./fixtures";
import { createTestDb, createUser, type TestDb } from "./testDb";

/**
 * 잡 큐 fencing (설계서 F-15 · R2-24 · 코드리뷰 #9).
 *
 * v3 초안은 `fence_token` 컬럼만 두고 증가·검증을 애플리케이션에 맡겼다.
 * 워커에게 jobs UPDATE 권한이 있는 한, 좀비 워커의 늦은 쓰기를 막을 방법이 없었다.
 * 이제 상태 전이는 RPC 로만 하고 워커의 UPDATE 권한을 회수했다.
 */

let db: TestDb;
let attemptId: string;
let adminId: string;
let userId: string;

beforeAll(async () => {
  db = await createTestDb("jobs");
  adminId = await createUser(db, "admin@example.kr", "admin");
  userId = await createUser(db, "user@example.kr", "user");
  const r = await createRun(db, "2026-11-01", "manual");
  attemptId = r.attemptId;
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.owner`delete from jobs`;
});

interface AcquiredJob {
  job_id: string;
  fence_token: string;
  stage: string;
  payload: unknown;
}

const enqueue = async (stage: string, key: string, maxAttempts = 3): Promise<string> => {
  const [row] = await db.owner<{ id: string }[]>`
    insert into jobs (attempt_id, stage, idempotency_key, payload, max_attempts)
    values (${attemptId}, ${stage}, ${key}, '{}'::jsonb, ${maxAttempts})
    returning id
  `;
  return row!.id;
};

const acquire = (worker: string, leaseSeconds = 120): Promise<AcquiredJob[]> =>
  db.asWorker((tx) => tx<AcquiredJob[]>`select * from public.acquire_job(${worker}, ${leaseSeconds})`);

const complete = (job: AcquiredJob, worker: string, success: boolean, err?: string): Promise<boolean> =>
  db
    .asWorker(
      (tx) => tx<{ complete_job: boolean }[]>`
        select public.complete_job(${job.job_id}::bigint, ${job.fence_token}::bigint,
                                   ${worker}, ${success}, ${err ?? null})`,
    )
    .then((rows) => rows[0]!.complete_job);

describe("acquire_job", () => {
  it("대기 중인 잡을 획득하고 fence_token 을 증가시킨다", async () => {
    await enqueue("collect", "k1");
    const [job] = await acquire("w1");
    expect(job!.stage).toBe("collect");
    expect(Number(job!.fence_token)).toBe(1);

    const [row] = await db.owner<{ status: string; locked_by: string; attempts: number }[]>`
      select status, locked_by, attempts from jobs where id = ${job!.job_id}
    `;
    expect(row!.status).toBe("running");
    expect(row!.locked_by).toBe("w1");
    // 크래시로 결과를 남기지 못한 시도도 세야 무한 재시도를 막는다.
    expect(row!.attempts).toBe(1);
  });

  it("이미 획득된 잡은 다시 주지 않는다", async () => {
    await enqueue("collect", "k1");
    const [first] = await acquire("w1");
    expect(first).toBeDefined();
    expect(await acquire("w2")).toHaveLength(0);
  });

  it("대기 중인 잡이 없으면 빈 결과를 준다", async () => {
    expect(await acquire("w1")).toHaveLength(0);
  });

  it("run_after 가 미래인 잡은 주지 않는다", async () => {
    const id = await enqueue("collect", "k1");
    await db.owner`update jobs set run_after = now() + interval '1 hour' where id = ${id}`;
    expect(await acquire("w1")).toHaveLength(0);
  });

  it("비정상 lease 길이를 거부한다", async () => {
    await expect(acquire("w1", 0)).rejects.toThrow(/invalid_lease/);
    await expect(acquire("w1", 99999)).rejects.toThrow(/invalid_lease/);
  });
});

describe("❗ fencing — 좀비 워커 차단", () => {
  it("현재 토큰으로는 heartbeat 가 성공한다", async () => {
    await enqueue("collect", "k1");
    const [job] = await acquire("w1");
    const [row] = await db.asWorker(
      (tx) => tx<{ heartbeat_job: boolean }[]>`
        select public.heartbeat_job(${job!.job_id}::bigint, ${job!.fence_token}::bigint, 'w1', 120)`,
    );
    expect(row!.heartbeat_job).toBe(true);
  });

  it("❗ 오래된 토큰의 heartbeat 는 실패한다 (워커가 즉시 중단해야 한다는 신호)", async () => {
    await enqueue("collect", "k1");
    const [stale] = await acquire("w1");
    // lease 만료 → reaper 가 회수 → 다른 워커가 다시 획득 (토큰 증가)
    await db.owner`update jobs set lease_expires_at = now() - interval '1 minute' where id = ${stale!.job_id}`;
    await db.asWorker((tx) => tx`select public.reap_expired_jobs()`);
    // reaper 는 백오프를 적용해 run_after 를 미래로 민다. 테스트에서는 즉시 당긴다.
    await db.owner`update jobs set run_after = now() where id = ${stale!.job_id}`;
    const [fresh] = await acquire("w2");
    expect(Number(fresh!.fence_token)).toBe(2);

    const [row] = await db.asWorker(
      (tx) => tx<{ heartbeat_job: boolean }[]>`
        select public.heartbeat_job(${stale!.job_id}::bigint, ${stale!.fence_token}::bigint, 'w1', 120)`,
    );
    expect(row!.heartbeat_job).toBe(false);
  });

  it("❗ 좀비 워커의 늦은 완료 보고는 무시된다", async () => {
    await enqueue("collect", "k1");
    const [stale] = await acquire("w1");
    await db.owner`update jobs set lease_expires_at = now() - interval '1 minute' where id = ${stale!.job_id}`;
    await db.asWorker((tx) => tx`select public.reap_expired_jobs()`);
    // reaper 는 백오프를 적용해 run_after 를 미래로 민다. 테스트에서는 즉시 당긴다.
    await db.owner`update jobs set run_after = now() where id = ${stale!.job_id}`;
    const [fresh] = await acquire("w2");

    // 좀비(w1)가 뒤늦게 성공을 보고한다
    expect(await complete(stale!, "w1", true)).toBe(false);
    const [row] = await db.owner<{ status: string }[]>`select status from jobs where id = ${stale!.job_id}`;
    expect(row!.status).toBe("running"); // w2 가 여전히 소유

    // 정당한 소유자(w2)의 보고는 반영된다
    expect(await complete(fresh!, "w2", true)).toBe(true);
    const [after] = await db.owner<{ status: string }[]>`select status from jobs where id = ${stale!.job_id}`;
    expect(after!.status).toBe("succeeded");
  });

  it("다른 워커 이름으로는 완료할 수 없다", async () => {
    await enqueue("collect", "k1");
    const [job] = await acquire("w1");
    expect(await complete(job!, "w2", true)).toBe(false);
  });
});

describe("complete_job — 재시도", () => {
  it("실패하면 백오프와 함께 재큐잉한다", async () => {
    await enqueue("collect", "k1", 3);
    const [job] = await acquire("w1");
    expect(await complete(job!, "w1", false, "일시 오류")).toBe(true);

    const [row] = await db.owner<{ status: string; last_error: string; future: boolean }[]>`
      select status, last_error, (run_after > now()) as future from jobs where id = ${job!.job_id}
    `;
    expect(row!.status).toBe("queued");
    expect(row!.last_error).toBe("일시 오류");
    expect(row!.future).toBe(true);
  });

  it("❗ 시도 횟수를 소진하면 dead 로 보낸다 (무한 재시도 방지)", async () => {
    await enqueue("collect", "k1", 2);
    for (let i = 0; i < 2; i++) {
      await db.owner`update jobs set run_after = now() where idempotency_key = 'k1'`;
      const [job] = await acquire("w1");
      await complete(job!, "w1", false, `실패 ${i}`);
    }
    const [row] = await db.owner<{ status: string; attempts: number }[]>`
      select status, attempts from jobs where idempotency_key = 'k1'
    `;
    expect(row!.status).toBe("dead");
    expect(row!.attempts).toBe(2);
  });
});

describe("reap_expired_jobs", () => {
  it("만료된 lease 를 회수한다", async () => {
    await enqueue("collect", "k1");
    const [job] = await acquire("w1");
    await db.owner`update jobs set lease_expires_at = now() - interval '1 second' where id = ${job!.job_id}`;

    const [n] = await db.asWorker((tx) => tx<{ reap_expired_jobs: number }[]>`select public.reap_expired_jobs()`);
    expect(n!.reap_expired_jobs).toBe(1);
    const [row] = await db.owner<{ status: string; locked_by: string | null }[]>`
      select status, locked_by from jobs where id = ${job!.job_id}
    `;
    expect(row!.status).toBe("queued");
    expect(row!.locked_by).toBeNull();
  });

  it("살아 있는 heartbeat 는 회수하지 않는다", async () => {
    await enqueue("collect", "k1");
    await acquire("w1");
    const [n] = await db.asWorker((tx) => tx<{ reap_expired_jobs: number }[]>`select public.reap_expired_jobs()`);
    expect(n!.reap_expired_jobs).toBe(0);
  });

  it("❗ 시도 횟수를 소진한 잡은 재큐잉하지 않고 dead 로 보낸다", async () => {
    const id = await enqueue("collect", "k1", 1);
    const [job] = await acquire("w1"); // attempts = 1 = max
    await db.owner`update jobs set lease_expires_at = now() - interval '1 second' where id = ${job!.job_id}`;
    await db.asWorker((tx) => tx`select public.reap_expired_jobs()`);

    const [row] = await db.owner<{ status: string }[]>`select status from jobs where id = ${id}`;
    expect(row!.status).toBe("dead");
  });
});

describe("❗ 워커 권한", () => {
  it("jobs 를 직접 UPDATE 할 수 없다", async () => {
    await enqueue("collect", "k1");
    await expect(db.asWorker((tx) => tx`update jobs set status = 'succeeded'`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("jobs 를 enqueue 하고 읽을 수는 있다", async () => {
    await db.asWorker(
      (tx) => tx`insert into jobs (attempt_id, stage, idempotency_key, payload)
                 values (${attemptId}, 'collect', 'worker-enq', '{}'::jsonb)`,
    );
    const rows = await db.asWorker((tx) => tx`select id from jobs where idempotency_key = 'worker-enq'`);
    expect(rows).toHaveLength(1);
  });

  it("일반 사용자는 잡 RPC 를 실행할 수 없다", async () => {
    await expect(db.asUser(userId, (tx) => tx`select public.acquire_job('w1', 120)`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe("관리자 RPC", () => {
  it("admin 은 역할을 바꿀 수 있다", async () => {
    const target = await createUser(db, `t-${Date.now()}@example.kr`, "user");
    await db.asUser(adminId, (tx) => tx`select public.set_profile_role(${target}::uuid, 'admin'::user_role)`);
    const [row] = await db.owner<{ role: string }[]>`select role from profiles where id = ${target}`;
    expect(row!.role).toBe("admin");
    // 정리
    await db.asUser(adminId, (tx) => tx`select public.set_profile_role(${target}::uuid, 'user'::user_role)`);
  });

  it("일반 사용자는 역할을 바꿀 수 없다", async () => {
    await expect(
      db.asUser(userId, (tx) => tx`select public.set_profile_role(${userId}::uuid, 'admin'::user_role)`),
    ).rejects.toThrow(/forbidden/);
  });

  it("❗ 마지막 admin 은 스스로를 강등할 수 없다 (잠김 방지)", async () => {
    await expect(
      db.asUser(adminId, (tx) => tx`select public.set_profile_role(${adminId}::uuid, 'user'::user_role)`),
    ).rejects.toThrow(/last_admin/);
  });

  it("❗ 소스 승인을 되돌릴 수 있다 (네이버 약관 문제 시 폴백 경로)", async () => {
    await db.asUser(
      adminId,
      (tx) => tx`select public.update_source_registry('naver_search', false, null, '약관 확인 중')`,
    );
    const [row] = await db.owner<{ approved: boolean; note: string }[]>`
      select approved, note from source_registry where source = 'naver_search'
    `;
    expect(row!.approved).toBe(false);
    expect(row!.note).toContain("약관");
  });

  it("일반 사용자는 소스 레지스트리를 바꿀 수 없다", async () => {
    await expect(
      db.asUser(userId, (tx) => tx`select public.update_source_registry('naver_search', true, null, null)`),
    ).rejects.toThrow(/forbidden/);
  });
});
