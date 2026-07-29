import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCandidate, createRun, createVerifiedEmail, type Candidate } from "./fixtures";
import { createTestDb, createUser, type TestDb } from "./testDb";

/**
 * RPC 통합 테스트.
 *
 * 여기서 검증하는 것은 대부분 **v2 에서 실제로 깨져 있던 동작**이다.
 * codex 라운드 2·3 이 잡아낸 결함들의 회귀 테스트다.
 */

let db: TestDb;
let userId: string;
let adminId: string;

beforeAll(async () => {
  db = await createTestDb("rpc");
  userId = await createUser(db, "reviewer@example.kr", "user");
  adminId = await createUser(db, "boss@example.kr", "admin");
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // 승인 카운터는 날짜 기준 전역이므로 테스트 간에 리셋한다.
  await db.owner`delete from leads`;
  await db.owner`delete from approval_day_totals`;
});

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

const decide = (actor: string, itemId: string, status: "approved" | "rejected", emailId?: string) =>
  db.asUser(actor, (tx) =>
    tx`select public.decide_review_item(
         ${itemId}::uuid, ${status}::review_status, null, ${emailId ?? null}::uuid) as r`,
  );

/**
 * run 의 동결 설정 중 한 섹션을 부분 갱신한다.
 *
 * ❗ 두 가지 함정이 있어서 헬퍼로 감쌌다.
 *   1. postgres.js 에 `JSON.stringify(x)` 를 넘기고 `::jsonb` 로 캐스팅하면 **이중 인코딩**되어
 *      jsonb 문자열이 되고, `obj || string` 은 병합이 아니라 **배열 연결**이 된다.
 *      → `sql.json(obj)` 로 넘겨야 한다.
 *   2. `jsonb || jsonb` 는 얕은 병합이라 섹션을 통째로 갈아치운다.
 *      → 섹션 내부에서 병합해 나머지 키를 보존한다.
 */
async function setRunSettings(
  runId: string,
  section: string,
  patch: Record<string, number | string | boolean>,
): Promise<void> {
  await db.owner`
    update runs
    set settings_snapshot = jsonb_set(
      settings_snapshot,
      array[${section}],
      coalesce(settings_snapshot -> ${section}, '{}'::jsonb) || ${db.owner.json(patch)}::jsonb
    )
    where id = ${runId}
  `;
}

/** 같은 run 에 승인 가능한 후보 n 개를 만든다. */
async function makeApprovable(n: number, industry = "derm"): Promise<{ runId: string; items: Candidate[]; emails: string[] }> {
  const { runId, attemptId } = await createRun(db, "2026-09-01", "manual");
  const items: Candidate[] = [];
  const emails: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await createCandidate(db, { industry, runId, attemptId, rank: i + 1 });
    items.push(c);
    emails.push(await createVerifiedEmail(db, c, userId));
  }
  return { runId, items, emails };
}

/** makeApprovable 과 같지만 attemptId 도 돌려준다. */
async function makeApprovableWithAttempt(
  n: number,
  industry = "derm",
): Promise<{ runId: string; attemptId: string; items: Candidate[]; emails: string[] }> {
  const { runId, attemptId } = await createRun(db, "2026-09-10", "manual");
  const items: Candidate[] = [];
  const emails: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await createCandidate(db, { industry, runId, attemptId, rank: i + 1 });
    items.push(c);
    emails.push(await createVerifiedEmail(db, c, userId));
  }
  return { runId, attemptId, items, emails };
}

// ── decide_review_item ───────────────────────────────────────────────────────

describe("decide_review_item — 승인", () => {
  it("❗ 업종의 첫 승인이 통과한다 (R2-01 회귀)", async () => {
    // v2 공식: (0+1)/(0+1) = 1.0 > 0.6 → 어떤 업종의 첫 건도 승인 불가.
    // 승인 기능 전체가 동작하지 않았다.
    const { items, emails } = await makeApprovable(1);
    const rows = await decide(userId, items[0]!.reviewItemId, "approved", emails[0]);
    expect(rows[0]!["r"]).toMatchObject({ ok: true, status: "approved" });

    const [lead] = await db.owner<{ n: string }[]>`select count(*)::text as n from leads`;
    expect(lead!.n).toBe("1");
  });

  it("승인하면 카운터가 증가한다", async () => {
    const { items, emails } = await makeApprovable(2);
    await decide(userId, items[0]!.reviewItemId, "approved", emails[0]);
    await decide(userId, items[1]!.reviewItemId, "approved", emails[1]);

    const [day] = await db.owner<{ approved_total: number }[]>`
      select approved_total from approval_day_totals where approval_date = current_date
    `;
    expect(day!.approved_total).toBe(2);
  });

  it("이메일 없이 승인할 수 없다", async () => {
    const { items } = await makeApprovable(1);
    await expect(decide(userId, items[0]!.reviewItemId, "approved")).rejects.toThrow(/email_required/);
  });

  it("MX 검증을 통과하지 않은 이메일로는 승인할 수 없다", async () => {
    const { items } = await makeApprovable(1);
    const [row] = await db.owner<{ id: string }[]>`
      insert into emails (company_id, address, local_part, domain, acquisition_method,
                          collection_legal_basis, entered_by, entered_at, source_contact_page_id,
                          mx_ok, is_personal_data, retention_until)
      values (${items[0]!.companyId}, 'nomx@example.kr', 'nomx', 'example.kr', 'manual_entry',
              'manual_from_public_site', ${userId}, now(), ${items[0]!.contactPageId},
              false, false, current_date + 1)
      returning id
    `;
    await expect(decide(userId, items[0]!.reviewItemId, "approved", row!.id)).rejects.toThrow(
      /email_not_verified/,
    );
  });

  it("❗ 무효화된 점수로는 승인할 수 없다 (워커가 점수를 갱신할 수 있으므로)", async () => {
    const { items, emails } = await makeApprovable(1);
    await db.owner`update scores set invalidated_at = now() where id = ${items[0]!.scoreId}`;
    await expect(decide(userId, items[0]!.reviewItemId, "approved", emails[0])).rejects.toThrow(
      /score_invalidated/,
    );
  });

  it("❗ 게이트를 통과하지 못한 점수로는 승인할 수 없다", async () => {
    const { items, emails } = await makeApprovable(1);
    await db.owner`update scores set gate_passed = false where id = ${items[0]!.scoreId}`;
    await expect(decide(userId, items[0]!.reviewItemId, "approved", emails[0])).rejects.toThrow(
      /score_gate_not_passed/,
    );
  });

  it("❗ 같은 run·업체에 리드가 이미 있으면 정제된 오류를 낸다", async () => {
    // 재실행 attempt 에서 같은 업체가 다시 올라올 수 있다.
    // 원시 unique_violation 대신 도메인 오류여야 API 가 사용자에게 설명할 수 있다.
    const { runId, attemptId, items, emails } = await makeApprovableWithAttempt(1);
    await decide(userId, items[0]!.reviewItemId, "approved", emails[0]);

    const [attempt2] = await db.owner<{ id: string }[]>`
      insert into run_attempts (run_id, attempt_no) values (${runId}, 2) returning id
    `;
    // 같은 run 의 새 attempt 에 **같은 업체**로 후보를 다시 만든다.
    const again = await createCandidate(db, {
      runId,
      attemptId: attempt2!.id,
      companyId: items[0]!.companyId,
      industry: "derm",
      rank: 1,
    });
    const email2 = await createVerifiedEmail(db, again, userId, "second@ex.kr");

    await expect(decide(userId, again.reviewItemId, "approved", email2)).rejects.toThrow(
      /lead_already_exists/,
    );
    expect(attemptId).toBeDefined();
  });

  it("다른 업체의 이메일로 승인할 수 없다", async () => {
    const { items, emails } = await makeApprovable(2);
    await expect(decide(userId, items[0]!.reviewItemId, "approved", emails[1])).rejects.toThrow(
      /email_not_verified/,
    );
  });
});

describe("decide_review_item — 상한", () => {
  it("일 승인 상한을 넘지 못한다", async () => {
    const { runId, items, emails } = await makeApprovable(3);
    await setRunSettings(runId, "targets", { final_max: 2, industry_share_max: 1.0, cooldown_rejected_days: 90 });

    await decide(userId, items[0]!.reviewItemId, "approved", emails[0]);
    await decide(userId, items[1]!.reviewItemId, "approved", emails[1]);
    await expect(decide(userId, items[2]!.reviewItemId, "approved", emails[2])).rejects.toThrow(
      /daily_cap_reached/,
    );
  });

  it("❗ 업종 쿼터는 floor(cap × share) 로 계산된다 (순서 독립)", async () => {
    const { runId, items, emails } = await makeApprovable(5, "dental");
    // cap 6, share 0.5 → 업종당 3건
    await setRunSettings(runId, "targets", { final_max: 6, industry_share_max: 0.5, cooldown_rejected_days: 90 });

    for (let i = 0; i < 3; i++) {
      await decide(userId, items[i]!.reviewItemId, "approved", emails[i]);
    }
    await expect(decide(userId, items[3]!.reviewItemId, "approved", emails[3])).rejects.toThrow(
      /industry_quota_exceeded/,
    );
  });

  it("업종 쿼터는 업종별로 독립이다", async () => {
    const { runId, attemptId } = await createRun(db, "2026-09-02", "manual");
    await setRunSettings(runId, "targets", { final_max: 4, industry_share_max: 0.5, cooldown_rejected_days: 90 });

    const mk = async (industry: string, rank: number) => {
      const c = await createCandidate(db, { industry, runId, attemptId, rank });
      return { c, e: await createVerifiedEmail(db, c, userId) };
    };
    const a1 = await mk("derm", 1);
    const a2 = await mk("derm", 2);
    const b1 = await mk("dental", 3);

    await decide(userId, a1.c.reviewItemId, "approved", a1.e);
    await decide(userId, a2.c.reviewItemId, "approved", a2.e);
    // derm 쿼터(2) 소진. dental 은 아직 남았다.
    await expect(decide(userId, b1.c.reviewItemId, "approved", b1.e)).resolves.toBeDefined();
  });

  it("❗ 동시 승인이 상한을 넘지 않는다 (행 잠금 직렬화)", async () => {
    const { runId, items, emails } = await makeApprovable(2);
    await setRunSettings(runId, "targets", { final_max: 1, industry_share_max: 1.0, cooldown_rejected_days: 90 });

    const results = await Promise.allSettled([
      decide(userId, items[0]!.reviewItemId, "approved", emails[0]),
      decide(userId, items[1]!.reviewItemId, "approved", emails[1]),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1);

    const [day] = await db.owner<{ approved_total: number }[]>`
      select approved_total from approval_day_totals where approval_date = current_date
    `;
    expect(day!.approved_total).toBe(1);
    const [lead] = await db.owner<{ n: string }[]>`select count(*)::text as n from leads`;
    expect(lead!.n).toBe("1");
  });

  it("❗ 서로 다른 업종의 동시 승인도 일 총량을 넘지 않는다", async () => {
    // v3 초안의 결함: 업종 행만 잠그면 두 업종이 같은 총합을 읽고 함께 통과했다.
    const { runId, attemptId } = await createRun(db, "2026-09-03", "manual");
    await setRunSettings(runId, "targets", { final_max: 1, industry_share_max: 1.0, cooldown_rejected_days: 90 });

    const mk = async (industry: string, rank: number) => {
      const c = await createCandidate(db, { industry, runId, attemptId, rank });
      return { c, e: await createVerifiedEmail(db, c, userId) };
    };
    const a = await mk("derm", 1);
    const b = await mk("dental", 2);

    const results = await Promise.allSettled([
      decide(userId, a.c.reviewItemId, "approved", a.e),
      decide(userId, b.c.reviewItemId, "approved", b.e),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);

    const [day] = await db.owner<{ approved_total: number }[]>`
      select approved_total from approval_day_totals where approval_date = current_date
    `;
    expect(day!.approved_total).toBe(1);
  });

  it("❗ 수동 run 을 추가해도 일 상한을 우회할 수 없다 (R2-18)", async () => {
    const first = await makeApprovable(1);
    await setRunSettings(first.runId, "targets", { final_max: 1, industry_share_max: 1.0, cooldown_rejected_days: 90 });
    await decide(userId, first.items[0]!.reviewItemId, "approved", first.emails[0]);

    // 새 run 을 만들어도 카운터는 **승인일** 기준이므로 이미 소진됐다.
    const second = await makeApprovable(1);
    await setRunSettings(second.runId, "targets", { final_max: 1, industry_share_max: 1.0, cooldown_rejected_days: 90 });
    await expect(decide(userId, second.items[0]!.reviewItemId, "approved", second.emails[0])).rejects.toThrow(
      /daily_cap_reached/,
    );
  });
});

describe("decide_review_item — 설정 fail-closed (R2-19)", () => {
  it("❗ 설정이 없으면 통과시키지 않고 configuration_error 를 낸다", async () => {
    const { runId, items, emails } = await makeApprovable(1);
    await db.owner`update runs set settings_snapshot = '{}'::jsonb where id = ${runId}`;
    await expect(decide(userId, items[0]!.reviewItemId, "approved", emails[0])).rejects.toThrow(
      /configuration_error/,
    );
  });

  it("❗ 비율이 범위를 벗어나면 거부한다", async () => {
    const { runId, items, emails } = await makeApprovable(1);
    await setRunSettings(runId, "targets", { final_max: 10, industry_share_max: 5, cooldown_rejected_days: 90 });
    await expect(decide(userId, items[0]!.reviewItemId, "approved", emails[0])).rejects.toThrow(
      /configuration_error/,
    );
  });
});

describe("decide_review_item — 상태 전이 (R2-16)", () => {
  it("제외하면 cooldown 이 설정된다", async () => {
    const { runId, items } = await makeApprovable(1);
    await setRunSettings(runId, "targets", { final_max: 50, industry_share_max: 0.6, cooldown_rejected_days: 45 });
    await decide(userId, items[0]!.reviewItemId, "rejected");

    const [c] = await db.owner<{ days: number }[]>`
      select extract(day from (next_eligible_at - now()))::int as days
      from companies where id = ${items[0]!.companyId}
    `;
    expect(c!.days).toBeGreaterThanOrEqual(44);
  });

  it("❗ 이미 결정된 항목은 다시 결정할 수 없다 (관리자도 예외 없음)", async () => {
    const { items, emails } = await makeApprovable(1);
    await decide(userId, items[0]!.reviewItemId, "approved", emails[0]);
    await expect(decide(userId, items[0]!.reviewItemId, "rejected")).rejects.toThrow(/already_decided/);
    await expect(decide(adminId, items[0]!.reviewItemId, "rejected")).rejects.toThrow(/already_decided/);
  });

  it("❗ status 를 pending 으로 되돌릴 수 없다", async () => {
    const { items } = await makeApprovable(1);
    await expect(
      db.asUser(userId, (tx) =>
        tx`select public.decide_review_item(${items[0]!.reviewItemId}::uuid, 'pending'::review_status, null, null)`,
      ),
    ).rejects.toThrow(/invalid_transition/);
  });

  it("비인증 호출을 거부한다", async () => {
    const { items } = await makeApprovable(1);
    await expect(
      db.asAnon((tx) =>
        tx`select public.decide_review_item(${items[0]!.reviewItemId}::uuid, 'rejected'::review_status, null, null)`,
      ),
    ).rejects.toThrow(/permission denied|unauthenticated/i);
  });
});

describe("revoke_approval — 보상 트랜잭션", () => {
  it("리드를 지우고 카운터를 되돌린다", async () => {
    const { items, emails } = await makeApprovable(1);
    await decide(userId, items[0]!.reviewItemId, "approved", emails[0]);

    await db.asUser(adminId, (tx) => tx`select public.revoke_approval(${items[0]!.reviewItemId}::uuid, '오판')`);

    const [lead] = await db.owner<{ n: string }[]>`select count(*)::text as n from leads`;
    expect(lead!.n).toBe("0");
    const [day] = await db.owner<{ approved_total: number }[]>`
      select approved_total from approval_day_totals where approval_date = current_date
    `;
    expect(day!.approved_total).toBe(0);
    const [item] = await db.owner<{ status: string }[]>`
      select status from review_items where id = ${items[0]!.reviewItemId}
    `;
    expect(item!.status).toBe("rejected");
  });

  it("일반 사용자는 취소할 수 없다", async () => {
    const { items, emails } = await makeApprovable(1);
    await decide(userId, items[0]!.reviewItemId, "approved", emails[0]);
    await expect(
      db.asUser(userId, (tx) => tx`select public.revoke_approval(${items[0]!.reviewItemId}::uuid, 'x')`),
    ).rejects.toThrow(/forbidden/);
  });

  it("취소 후 상한이 다시 열린다", async () => {
    const { runId, items, emails } = await makeApprovable(2);
    await setRunSettings(runId, "targets", { final_max: 1, industry_share_max: 1.0, cooldown_rejected_days: 90 });

    await decide(userId, items[0]!.reviewItemId, "approved", emails[0]);
    await expect(decide(userId, items[1]!.reviewItemId, "approved", emails[1])).rejects.toThrow(/daily_cap_reached/);

    await db.asUser(adminId, (tx) => tx`select public.revoke_approval(${items[0]!.reviewItemId}::uuid, '취소')`);
    await expect(decide(userId, items[1]!.reviewItemId, "approved", emails[1])).resolves.toBeDefined();
  });
});
