import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCandidate, type Candidate } from "./fixtures";
import { createTestDb, createUser, type TestDb } from "./testDb";

/**
 * RLS 우회 시도 — 설계서 F-12 회귀 테스트.
 *
 * v2 는 `review_decide` UPDATE 정책에 `WITH CHECK (true)` 를 두어, 인증된 일반
 * 사용자가 PostgREST 로 `PATCH /review_items?id=eq.X` 를 호출해 status 를 포함한
 * 모든 컬럼을 임의 변경하고 승인 상한을 우회할 수 있었다.
 *
 * 아래 테스트는 **공격자 관점**에서 직접 써보고 전부 막히는지 확인한다.
 */

let db: TestDb;
let userId: string;
let adminId: string;
let cand: Candidate;

beforeAll(async () => {
  db = await createTestDb("rls");
  userId = await createUser(db, "user@example.kr", "user");
  adminId = await createUser(db, "admin@example.kr", "admin");
  cand = await createCandidate(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("익명(비로그인)", () => {
  it("어떤 테이블도 읽을 수 없다", async () => {
    for (const table of ["companies", "review_items", "leads", "emails", "settings"]) {
      await expect(
        db.asAnon((tx) => tx.unsafe(`select * from ${table} limit 1`)),
        table,
      ).rejects.toThrow(/permission denied/i);
    }
  });
});

describe("일반 사용자 — 읽기", () => {
  it("검수에 필요한 테이블을 읽을 수 있다", async () => {
    const rows = await db.asUser(userId, (tx) => tx`select id from review_items`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("감사 로그·비용·잡은 읽을 수 없다 (admin 전용)", async () => {
    for (const table of ["audit_log", "cost_ledger", "jobs"]) {
      const rows = await db.asUser(userId, (tx) => tx.unsafe(`select * from ${table}`));
      expect(rows.length, table).toBe(0); // RLS 로 0행
    }
  });

  it("admin 은 감사 로그를 읽을 수 있다", async () => {
    await db.owner`insert into audit_log (action, entity) values ('t', 'e')`;
    const rows = await db.asUser(adminId, (tx) => tx`select * from audit_log`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("❗ 승인 카운터·nonce 는 읽을 수조차 없다", async () => {
    for (const table of ["approval_counters", "approval_day_totals", "review_view_nonces", "http_cache"]) {
      await expect(
        db.asUser(userId, (tx) => tx.unsafe(`select * from ${table}`)),
        table,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("다른 사람의 profile 은 보이지 않는다", async () => {
    const rows = await db.asUser(userId, (tx) => tx<{ id: string }[]>`select id from profiles`);
    expect(rows.map((r) => r.id)).toEqual([userId]);
  });
});

describe("❗ 일반 사용자 — 쓰기 시도는 전부 막힌다", () => {
  it("review_items 를 직접 UPDATE 할 수 없다 (v2 의 구멍)", async () => {
    await expect(
      db.asUser(userId, (tx) => tx`update review_items set status = 'approved' where id = ${cand.reviewItemId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("leads 를 직접 INSERT 할 수 없다", async () => {
    await expect(
      db.asUser(
        userId,
        (tx) => tx`
          insert into leads (run_id, company_id, review_item_id, email_id, score, snapshot, retention_until)
          values (${cand.runId}, ${cand.companyId}, ${cand.reviewItemId},
                  ${cand.companyId}, 99, '{}'::jsonb, current_date + 1)
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("scores 를 조작해 게이트를 통과시킬 수 없다", async () => {
    await expect(
      db.asUser(userId, (tx) => tx`update scores set total = 100 where id = ${cand.scoreId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("settings 를 직접 바꿔 상한을 올릴 수 없다", async () => {
    await expect(
      db.asUser(userId, (tx) => tx`update settings set value = '{"final_max":9999}'::jsonb where key = 'targets'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("emails 를 직접 INSERT 해 수동 입력 절차를 건너뛸 수 없다", async () => {
    await expect(
      db.asUser(
        userId,
        (tx) => tx`
          insert into emails (company_id, address, local_part, domain, acquisition_method,
                              collection_legal_basis, is_personal_data, retention_until, mx_ok)
          values (${cand.companyId}, 'x@y.kr', 'x', 'y.kr', 'public_api',
                  'public_api_field', false, current_date + 1, true)
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("companies 의 do_not_contact 를 꺼서 수신거부를 무력화할 수 없다", async () => {
    await expect(
      db.asUser(userId, (tx) => tx`update companies set do_not_contact = false`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("admin 도 테이블을 직접 쓸 수 없다 (모든 쓰기는 RPC 를 통한다)", async () => {
    await expect(
      db.asUser(adminId, (tx) => tx`update settings set value = '{}'::jsonb where key = 'targets'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("DELETE 도 막힌다", async () => {
    await expect(
      db.asUser(adminId, (tx) => tx`delete from review_items where id = ${cand.reviewItemId}`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("워커 역할", () => {
  it("파이프라인 테이블에는 쓸 수 있다", async () => {
    const inserted = await db.asWorker(
      (tx) => tx<{ id: string }[]>`
        insert into companies (dedupe_key, name, normalized_name, industry)
        values (${`worker-${Math.random()}`}, 'w', 'w', 'dental')
        returning id
      `,
    );
    expect(inserted).toHaveLength(1);
  });

  it("❗ leads 에는 쓸 수 없다 (리드는 승인 RPC 만 만든다)", async () => {
    await expect(
      db.asWorker(
        (tx) => tx`
          insert into leads (run_id, company_id, review_item_id, email_id, score, snapshot, retention_until)
          values (${cand.runId}, ${cand.companyId}, ${cand.reviewItemId},
                  ${cand.companyId}, 1, '{}'::jsonb, current_date + 1)
        `,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("❗ settings 를 바꿀 수 없다", async () => {
    await expect(
      db.asWorker((tx) => tx`update settings set value = '{}'::jsonb where key = 'targets'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("❗ 승인 카운터에 접근할 수 없다", async () => {
    await expect(
      db.asWorker((tx) => tx`select * from approval_day_totals`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("❗ auth 스키마에 접근할 수 없다", async () => {
    await expect(db.asWorker((tx) => tx`select * from auth.users`)).rejects.toThrow(/permission denied/i);
  });
});
