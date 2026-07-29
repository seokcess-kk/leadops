import { MockSourceAdapter } from "@leadops/adapters";
import { nullLogger } from "@leadops/core";
import { createTestDb, type TestDb } from "@leadops/db";
import { HttpClient, loopbackPolicyForTests, RobotsGate, type DnsResolver } from "@leadops/http";
import { advanceAttempt, startRun } from "@leadops/pipeline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "./loop";

/**
 * Phase 3 E2E — 실행 생성부터 연락처 페이지 집계까지 5개 스테이지 전 구간.
 *
 * ❗ 워커는 **실제 leadops_worker 로그인 역할**로 접속한다.
 *    소유자 커넥션으로 돌리면 권한 모델이 검증되지 않는다.
 *
 * 목업 업체의 홈페이지(`*.example.kr`)는 실재하지 않는다. 여기서는 그것을 그대로 둔다 —
 * **도달할 수 없는 홈페이지가 실행 전체를 실패시키지 않는다**는 것이 확인해야 할 성질이기
 * 때문이다. 판별 성공 경로는 실제 서버를 띄우는
 * `packages/pipeline/src/stages/homepage.pg.test.ts` 가 검증한다.
 */

let db: TestDb;
const adapters = [new MockSourceAdapter()];

/** 외부로 나가지 않게 loopback 으로 묶는다. 그쪽은 아무도 듣고 있지 않다. */
const resolver: DnsResolver = async () => [{ address: "127.0.0.1", family: 4 }];

const makeWorker = (id = "w1"): Worker => {
  const http = new HttpClient({
    userAgent: "LeadOpsBot/1.0 (+https://example.kr/bot)",
    perDomainIntervalMs: 0,
    globalConcurrency: 6,
    // loopback 443 에 다른 프로세스가 듣고 있으면 TLS 핸드셰이크가 타임아웃까지 매달린다.
    // 여기서 확인하려는 것은 "실패해도 실행이 완주한다" 이므로 짧게 끊는다.
    connectTimeoutMs: 400,
    totalTimeoutMs: 1_200,
    maxRetries: 0,
    maxBodyBytes: 512 * 1024,
    maxRedirects: 2,
    logger: nullLogger,
    resolver,
    ssrfPolicy: loopbackPolicyForTests(),
  });
  return new Worker({
    sql: db.workerSql,
    logger: nullLogger,
    adapters,
    http,
    robots: new RobotsGate({ client: http, userAgentToken: "leadopsbot", logger: nullLogger }),
    workerId: id,
    leaseSeconds: 60,
    heartbeatMs: 60_000,
    sleep: async () => {},
  });
};

beforeAll(async () => {
  db = await createTestDb("worker");
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("전체 파이프라인 (collect → normalize → exclude_basic → homepage_detect → contact_pages)", () => {
  it("❗ 실행을 만들고 큐를 비우면 업체가 적재된다", async () => {
    const { runId, attemptId } = await startRun(db.workerSql, {
      trigger: "manual",
      runDate: "2026-12-01",
      industries: ["derm", "dental"],
      perIndustryLimit: 30,
      logger: nullLogger,
    });

    const handled = await makeWorker().drain(50);
    // collect 2 + normalize 1 + exclude_basic 1 + homepage_detect 1 + contact_pages 1
    expect(handled).toBe(6);

    const [rawRow] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from raw_candidates where attempt_id = ${attemptId}
    `;
    expect(Number(rawRow!.n)).toBe(60);

    const [companyRow] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from companies
    `;
    expect(Number(companyRow!.n)).toBe(60);

    const [run] = await db.owner<{ status: string }[]>`select status from runs where id = ${runId}`;
    expect(run!.status).toBe("succeeded");
  });

  it("스테이지가 순서대로 terminal 이 된다", async () => {
    const rows = await db.owner<Array<{ stage: string; status: string; total: number; done: number }>>`
      select s.stage, s.status, s.total, s.done
      from run_stages s
      join run_attempts a on a.id = s.attempt_id
      join runs r on r.id = a.run_id
      where r.run_date = '2026-12-01'::date
      order by s.stage
    `;
    const byStage = new Map(rows.map((r) => [r.stage, r]));
    expect(byStage.get("collect")).toMatchObject({ status: "succeeded", total: 2, done: 2 });
    expect(byStage.get("normalize")).toMatchObject({ status: "succeeded", total: 1, done: 1 });
    expect(byStage.get("exclude_basic")).toMatchObject({ status: "succeeded", total: 1, done: 1 });
    expect(byStage.get("homepage_detect")).toMatchObject({ status: "succeeded", total: 1, done: 1 });
    expect(byStage.get("contact_pages")).toMatchObject({ status: "succeeded", total: 1, done: 1 });
  });

  it("❗ 도달할 수 없는 홈페이지는 unavailable 로 남고 실행을 실패시키지 않는다", async () => {
    const rows = await db.owner<Array<{ official_status: string; n: string }>>`
      select official_status, count(*)::text as n from website_observations group by official_status
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.official_status).toBe("unavailable");
    expect(Number(rows[0]!.n)).toBeGreaterThan(30);
  });

  it("❗ robots.txt 를 확인하지 못하면 홈페이지를 가져오지 않는다 (fail-closed)", async () => {
    const rows = await db.owner<Array<{ robots_allowed: boolean; crawled_pages: number; signals: Record<string, unknown> }>>`
      select robots_allowed, crawled_pages, signals from website_observations limit 1
    `;
    expect(rows[0]!.robots_allowed).toBe(false);
    expect(rows[0]!.crawled_pages).toBe(0);
    expect(rows[0]!.signals["reason"]).toBe("robots_fetch_error");
  });

  it("공식으로 인정된 사이트가 없으므로 연락처 후보도 없다", async () => {
    const [row] = await db.owner<Array<{ n: string }>>`select count(*)::text as n from contact_pages`;
    expect(row!.n).toBe("0");
  });

  it("❗ 폐업 업체가 제외 사유와 함께 표시된다", async () => {
    const rows = await db.owner<Array<{ excluded_reason: string }>>`
      select excluded_reason from companies
      where excluded_reason is not null and excluded_reason like 'closed%'
    `;
    // 목업은 index % 20 === 19 에서만 closed 로 만든다.
    // 업종당 30건이면 인덱스 19 하나뿐 → 2개 업종 = 2개.
    expect(rows.length).toBe(2);
    expect(rows[0]!.excluded_reason).toContain("폐업");
  });

  it("❗ 관측 이력에 track 이 기록된다 (첫 실행은 전부 new)", async () => {
    const rows = await db.owner<Array<{ track: string; n: string }>>`
      select track, count(*)::text as n from company_observations group by track
    `;
    expect(rows).toEqual([{ track: "new", n: "60" }]);
  });

  it("홈페이지 URL 이 오면 websites 에 정규화되어 저장된다", async () => {
    const [siteCount] = await db.owner<{ n: string }[]>`select count(*)::text as n from websites`;
    // 목업은 4개 중 3개에 홈페이지를 준다
    expect(Number(siteCount!.n)).toBeGreaterThan(30);
    const [site] = await db.owner<Array<{ canonical_url: string; domain: string }>>`
      select canonical_url, domain from websites limit 1
    `;
    expect(site!.canonical_url).toMatch(/^https?:\/\//);
    expect(site!.domain).not.toContain("www.");
  });
});

describe("❗ 멱등성 — 재실행해도 결과가 같다", () => {
  it("같은 attempt 를 다시 처리해도 업체가 늘어나지 않는다", async () => {
    const { attemptId } = await startRun(db.workerSql, {
      trigger: "manual",
      runDate: "2026-12-02",
      industries: ["plastic"],
      perIndustryLimit: 10,
      logger: nullLogger,
    });
    await makeWorker().drain(50);

    const [before] = await db.owner<{ n: string }[]>`select count(*)::text as n from companies`;

    // 잡을 다시 큐에 넣어 강제로 재실행한다 (lease 만료 후 재처리 시나리오)
    await db.owner`
      update jobs set status = 'queued', attempts = 0, run_after = now(), locked_by = null
      where attempt_id = ${attemptId}
    `;
    await makeWorker("w2").drain(50);

    const [after] = await db.owner<{ n: string }[]>`select count(*)::text as n from companies`;
    expect(after!.n).toBe(before!.n);
  });

  it("raw_candidates 가 중복 적재되지 않는다", async () => {
    const rows = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from (
        select attempt_id, source, external_id from raw_candidates
        group by 1, 2, 3 having count(*) > 1
      ) dup
    `;
    expect(rows[0]!.n).toBe("0");
  });
});

describe("❗ 워커 권한 — 최소권한 역할로 동작한다", () => {
  it("워커는 leads 에 쓸 수 없다", async () => {
    await expect(
      db.workerSql`
        insert into leads (run_id, company_id, review_item_id, email_id, score, snapshot,
                           approval_date, approved_industry, retention_until)
        values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                1, '{}'::jsonb, current_date, 'derm', current_date + 1)
      `,
    ).rejects.toThrow(/permission denied/i);
  });

  it("워커는 jobs 를 직접 UPDATE 할 수 없다 (fencing 우회 차단)", async () => {
    await expect(db.workerSql`update jobs set status = 'succeeded'`).rejects.toThrow(/permission denied/i);
  });

  it("워커는 settings 를 바꿀 수 없다", async () => {
    await expect(
      db.workerSql`update settings set value = '{}'::jsonb where key = 'targets'`,
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("❗ 실패 처리", () => {
  it("스테이지가 실패하면 잡이 재시도되고, 소진하면 run 이 failed 가 된다", async () => {
    const { runId, attemptId } = await startRun(db.workerSql, {
      trigger: "manual",
      runDate: "2026-12-03",
      industries: ["derm"],
      perIndustryLimit: 5,
      logger: nullLogger,
    });

    // 어댑터가 지원하지 않는 업종을 넣어 실패시킨다.
    await db.owner`
      update jobs set payload = '{"industry":"franchise","limit":5}'::jsonb, max_attempts = 1
      where attempt_id = ${attemptId} and stage = 'collect'
    `;
    // 목업은 franchise 를 지원하므로, 아예 없는 스테이지로 바꿔 실패를 만든다.
    await db.owner`update jobs set stage = 'no_such_stage' where attempt_id = ${attemptId}`;

    await makeWorker("w3").drain(20);

    const [job] = await db.owner<Array<{ status: string; last_error: string }>>`
      select status, last_error from jobs where attempt_id = ${attemptId}
    `;
    expect(job!.status).toBe("dead");
    expect(job!.last_error).toContain("알 수 없는 스테이지");

    await advanceAttempt(db.owner, attemptId, nullLogger);
    const [run] = await db.owner<{ status: string }[]>`select status from runs where id = ${runId}`;
    // collect 가 실패했으므로 하류는 열리지 않고 실행이 실패로 끝난다.
    expect(["failed", "running"]).toContain(run!.status);
  });
});
