import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCandidate, createRun, createUser, createVerifiedEmail, createTestDb, type Candidate, type TestDb } from "./index";

/**
 * Phase 7 — 개인정보 집행 · 용량 게이트 · 스케줄 판정.
 *
 * 실제 Postgres 를 쓴다. `pg_database_size`·`security definer`·행 잠금은 흉내 낼 수 없다.
 */

let db: TestDb;
let admin: string;
let reviewer: string;

beforeAll(async () => {
  db = await createTestDb("ops");
  admin = await createUser(db, "ops-admin@example.kr", "admin");
  reviewer = await createUser(db, "ops-user@example.kr", "user");
}, 180_000);

afterAll(async () => {
  await db.close();
});

/** 개인정보 요청을 접수한다 (정보주체 권리이므로 일반 사용자도 접수할 수 있다). */
async function request(kind: string, subject: string, actor = reviewer): Promise<string> {
  const rows = await db.asUser(actor, (tx) => tx<Array<{ create_privacy_request: { request_id: string } }>>`
    select public.create_privacy_request(${kind}, ${subject}, null)
  `);
  return rows[0]!.create_privacy_request.request_id;
}

async function candidateWithEmail(): Promise<{ candidate: Candidate; address: string }> {
  const { runId, attemptId } = await createRun(db);
  const candidate = await createCandidate(db, { runId, attemptId });
  const address = `contact-${Math.random().toString(36).slice(2, 8)}@example.kr`;
  await createVerifiedEmail(db, candidate, admin, address);
  return { candidate, address };
}

describe("개인정보 상태 전이 — advance_privacy_request", () => {
  it("admin 이 아니면 거절한다", async () => {
    const id = await request("access", "someone@example.kr");
    await expect(
      db.asUser(reviewer, (tx) => tx`select public.advance_privacy_request(${id}, 'in_progress', null)`),
    ).rejects.toThrow(/forbidden/);
  });

  it("received → in_progress → completed 로 진행한다", async () => {
    const id = await request("access", "flow@example.kr");
    await db.asUser(admin, (tx) => tx`select public.advance_privacy_request(${id}, 'in_progress', null)`);
    await db.asUser(admin, (tx) => tx`select public.advance_privacy_request(${id}, 'completed', null)`);

    const [row] = await db.owner<Array<{ status: string; completed_by: string | null }>>`
      select status, completed_by from privacy_requests where id = ${id}
    `;
    expect(row?.status).toBe("completed");
    expect(row?.completed_by).toBe(admin);
  });

  it("❗ received 로 되돌리는 전이는 없다 (접수 시각·기한이 흔들린다)", async () => {
    const id = await request("access", "back@example.kr");
    await expect(
      db.asUser(admin, (tx) => tx`select public.advance_privacy_request(${id}, 'received', null)`),
    ).rejects.toThrow(/invalid_transition/);
  });

  it("❗ 종결된 요청은 다시 열 수 없다", async () => {
    const id = await request("access", "closed@example.kr");
    await db.asUser(admin, (tx) => tx`select public.advance_privacy_request(${id}, 'completed', null)`);
    await expect(
      db.asUser(admin, (tx) => tx`select public.advance_privacy_request(${id}, 'in_progress', null)`),
    ).rejects.toThrow(/already_decided/);
  });

  it("❗ 보류·거절은 사유 없이 존재할 수 없다", async () => {
    const id = await request("delete", "hold@example.kr");
    for (const status of ["on_hold", "rejected"]) {
      await expect(
        db.asUser(admin, (tx) => tx`select public.advance_privacy_request(${id}, ${status}, '  ')`),
      ).rejects.toThrow(/reason_required/);
    }
    await db.asUser(admin, (tx) => tx`select public.advance_privacy_request(${id}, 'on_hold', '분쟁 진행 중')`);
    const [row] = await db.owner<Array<{ hold_reason: string }>>`
      select hold_reason from privacy_requests where id = ${id}
    `;
    expect(row?.hold_reason).toBe("분쟁 진행 중");
  });

  it("기한은 접수 시점에 10일로 못 박힌다 (시행령 제41·43·44조)", async () => {
    const id = await request("access", "due@example.kr");
    const [row] = await db.owner<Array<{ days: number }>>`
      select round(extract(epoch from (due_at - received_at)) / 86400)::int as days
      from privacy_requests where id = ${id}
    `;
    expect(row?.days).toBe(10);
  });
});

describe("열람 — privacy_access_report", () => {
  it("보유한 이메일과 근거 페이지를 그대로 돌려준다 (마스킹하지 않는다)", async () => {
    const { address } = await candidateWithEmail();
    const id = await request("access", address);

    const rows = await db.asUser(admin, (tx) => tx<Array<{ privacy_access_report: {
      emails: Array<{ address: string; acquisition_method: string; source_url: string | null }>;
      note: string;
    } }>>`select public.privacy_access_report(${id})`);
    const report = rows[0]!.privacy_access_report;

    expect(report.emails).toHaveLength(1);
    expect(report.emails[0]?.address).toBe(address);
    // 수동 입력이라는 사실과 근거 URL 이 함께 나와야 열람권이 이행된다.
    expect(report.emails[0]?.acquisition_method).toBe("manual_entry");
    expect(report.emails[0]?.source_url).toMatch(/\/contact$/);
    expect(report.note).toContain("자동 수집하지 않습니다");
  });

  it("❗ 열람 자체가 감사 로그에 남는다", async () => {
    const { address } = await candidateWithEmail();
    const id = await request("access", address);
    await db.asUser(admin, (tx) => tx`select public.privacy_access_report(${id})`);

    const [row] = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from audit_log
      where action = 'privacy.access' and entity_id = ${id}
    `;
    expect(row?.n).toBe("1");
  });

  it("admin 이 아니면 거절한다 (요청자 식별자가 남에게 보이면 그 자체가 유출)", async () => {
    const id = await request("access", "leak@example.kr");
    await expect(
      db.asUser(reviewer, (tx) => tx`select public.privacy_access_report(${id})`),
    ).rejects.toThrow(/forbidden/);
  });
});

describe("삭제·처리정지 집행 — execute_privacy_request", () => {
  it("delete 는 이메일을 파기하고 접촉을 영구 차단한다", async () => {
    const { candidate, address } = await candidateWithEmail();
    const id = await request("delete", address);

    const rows = await db.asUser(admin, (tx) => tx<Array<{ execute_privacy_request: {
      emails_deleted: number; do_not_contact: boolean;
    } }>>`select public.execute_privacy_request(${id})`);
    expect(rows[0]!.execute_privacy_request.emails_deleted).toBe(1);

    const [emails] = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from emails where company_id = ${candidate.companyId}
    `;
    expect(emails?.n).toBe("0");

    const [company] = await db.owner<Array<{ do_not_contact: boolean; opt_out_at: string | null }>>`
      select do_not_contact, opt_out_at from companies where id = ${candidate.companyId}
    `;
    expect(company?.do_not_contact).toBe(true);
    expect(company?.opt_out_at).not.toBeNull();

    const [req] = await db.owner<Array<{ status: string; actions: unknown[] }>>`
      select status, actions_taken as actions from privacy_requests where id = ${id}
    `;
    expect(req?.status).toBe("completed");
    expect(req?.actions).toHaveLength(1);
  });

  it("❗ 업체 행 자체는 지우지 않는다 (지우면 재수집 대상이 되어 다시 올라온다)", async () => {
    const { candidate, address } = await candidateWithEmail();
    const id = await request("delete", address);
    await db.asUser(admin, (tx) => tx`select public.execute_privacy_request(${id})`);

    const [row] = await db.owner<Array<{ n: string; eligible_far: boolean }>>`
      select count(*)::text as n,
             bool_and(next_eligible_at > now() + interval '50 years') as eligible_far
      from companies where id = ${candidate.companyId}
    `;
    expect(row?.n).toBe("1");
    // 재평가 풀로 돌아오지 못한다.
    expect(row?.eligible_far).toBe(true);
  });

  it("suspend 는 파기하지 않고 접촉만 막는다", async () => {
    const { candidate, address } = await candidateWithEmail();
    const id = await request("suspend", address);

    const rows = await db.asUser(admin, (tx) => tx<Array<{ execute_privacy_request: { emails_deleted: number } }>>`
      select public.execute_privacy_request(${id})
    `);
    expect(rows[0]!.execute_privacy_request.emails_deleted).toBe(0);

    const [emails] = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from emails where company_id = ${candidate.companyId}
    `;
    expect(emails?.n).toBe("1");
    const [company] = await db.owner<Array<{ do_not_contact: boolean }>>`
      select do_not_contact from companies where id = ${candidate.companyId}
    `;
    expect(company?.do_not_contact).toBe(true);
  });

  it("❗ legal_hold 가 걸린 이메일은 파기하지 않고 건수를 남긴다", async () => {
    const { candidate, address } = await candidateWithEmail();
    await db.owner`update emails set legal_hold = true where company_id = ${candidate.companyId}`;
    const id = await request("delete", address);

    const rows = await db.asUser(admin, (tx) => tx<Array<{ execute_privacy_request: {
      emails_deleted: number; emails_retained_legal_hold: number;
    } }>>`select public.execute_privacy_request(${id})`);
    expect(rows[0]!.execute_privacy_request.emails_deleted).toBe(0);
    expect(rows[0]!.execute_privacy_request.emails_retained_legal_hold).toBe(1);
  });

  it("❗ 요청에 legal_hold 가 걸리면 집행 자체를 거절한다 (보존 의무)", async () => {
    const { address } = await candidateWithEmail();
    const id = await request("delete", address);
    await db.owner`update privacy_requests set legal_hold = true where id = ${id}`;
    await expect(
      db.asUser(admin, (tx) => tx`select public.execute_privacy_request(${id})`),
    ).rejects.toThrow(/legal_hold/);
  });

  it("❗ 주체를 특정하지 못하면 조용히 0건 처리하지 않는다", async () => {
    const id = await request("delete", "nobody-we-hold@example.kr");
    await expect(
      db.asUser(admin, (tx) => tx`select public.execute_privacy_request(${id})`),
    ).rejects.toThrow(/subject_not_matched/);
  });

  it("access·correct 는 집행 대상이 아니다", async () => {
    const { address } = await candidateWithEmail();
    for (const kind of ["access", "correct"]) {
      const id = await request(kind, address);
      await expect(
        db.asUser(admin, (tx) => tx`select public.execute_privacy_request(${id})`),
      ).rejects.toThrow(/invalid_kind/);
    }
  });

  it("❗ 집행 후에는 export 후보에서 빠진다", async () => {
    const { candidate, address } = await candidateWithEmail();
    // 승인해서 리드를 만든다.
    const [email] = await db.owner<Array<{ id: string }>>`
      select id from emails where company_id = ${candidate.companyId} limit 1
    `;
    await db.asUser(admin, (tx) => tx`
      select public.decide_review_item(${candidate.reviewItemId}, 'approved', null, ${email!.id}::uuid)
    `);
    const before = await db.asUser(admin, (tx) => tx<Array<{ export_leads: unknown }>>`
      select public.export_leads(current_date, current_date)
    `);
    expect(before.length).toBe(1);

    const id = await request("suspend", address);
    await db.asUser(admin, (tx) => tx`select public.execute_privacy_request(${id})`);

    const after = await db.asUser(admin, (tx) => tx<Array<{ export_leads: unknown }>>`
      select public.export_leads(current_date, current_date)
    `);
    expect(after.length).toBe(0);
  });
});

describe("용량 게이트 — db_capacity · assert_capacity_for_run", () => {
  it("임계 레벨을 상한 기준으로 계산한다", async () => {
    const [row] = await db.owner<Array<{ db_capacity: { bytes: number; pct: number; level: string } }>>`
      select public.db_capacity()
    `;
    expect(row!.db_capacity.bytes).toBeGreaterThan(0);
    expect(row!.db_capacity.level).toBe("ok");

    // 상한을 실제 크기보다 작게 주면 block 이 되어야 한다.
    const bytes = row!.db_capacity.bytes;
    const levels = await db.owner<Array<{ level: string }>>`
      select (public.db_capacity((${bytes} / 0.5)::bigint) ->> 'level') as level
      union all select (public.db_capacity((${bytes} / 0.75)::bigint) ->> 'level')
      union all select (public.db_capacity((${bytes} / 0.87)::bigint) ->> 'level')
      union all select (public.db_capacity((${bytes} / 0.95)::bigint) ->> 'level')
    `;
    expect(levels.map((r) => r.level)).toEqual(["ok", "warn", "cleanup", "block"]);
  });

  it("❗ 상한이 0 이하면 통과가 아니라 에러다 (fail-closed)", async () => {
    await expect(db.owner`select public.db_capacity(0::bigint)`).rejects.toThrow(/configuration_error/);
  });

  it("❗ 90% 이상이면 신규 실행을 차단한다", async () => {
    const [cap] = await db.owner<Array<{ bytes: number }>>`
      select (public.db_capacity() ->> 'bytes')::bigint as bytes
    `;
    // 설정으로 상한을 낮춰 block 상태를 만든다.
    await db.owner`
      update settings set value = jsonb_set(value, '{limit_bytes}', to_jsonb((${cap!.bytes} / 0.95)::bigint))
      where key = 'capacity'
    `;
    await expect(db.owner`select public.assert_capacity_for_run()`).rejects.toThrow(/capacity_exceeded/);

    await db.owner`
      update settings set value = jsonb_set(value, '{limit_bytes}', to_jsonb(524288000::bigint))
      where key = 'capacity'
    `;
    await expect(db.owner`select public.assert_capacity_for_run()`).resolves.toBeDefined();
  });

  it("cleanup_by_capacity 는 평시에 공격적으로 지우지 않는다", async () => {
    const rows = await db.owner<Array<{ cleanup_by_capacity: {
      capacity_before: { level: string }; aggressive: Record<string, unknown>;
    } }>>`select public.cleanup_by_capacity()`;
    const result = rows[0]!.cleanup_by_capacity;
    expect(result.capacity_before.level).toBe("ok");
    // ok 레벨에서는 추가 삭제가 없어야 한다.
    expect(result.aggressive).toEqual({});
  });

  it("capacity_report 는 admin 전용이고 테이블별 크기를 준다", async () => {
    await expect(
      db.asUser(reviewer, (tx) => tx`select public.capacity_report()`),
    ).rejects.toThrow(/forbidden/);

    const rows = await db.asUser(admin, (tx) => tx<Array<{ capacity_report: {
      capacity: { level: string }; tables: Array<{ table: string; total_bytes: number }>;
    } }>>`select public.capacity_report()`);
    const report = rows[0]!.capacity_report;
    expect(report.capacity.level).toBe("ok");
    expect(report.tables.length).toBeGreaterThan(10);
    expect(report.tables.map((t) => t.table)).toContain("companies");
  });
});

/**
 * ❗ 회귀 테스트 — `settings` 단일 행에 중첩 경로를 쓴 결함 (0013).
 *
 * 세 설정이 **조용히 기본값으로** 동작했다. 시드 값이 코드 기본값과 같아서(30·3·3) 기존
 * 테스트도 통과했다. 그래서 "저장된다" 가 아니라 **"바꾼 값이 실제로 동작을 바꾼다"** 를 본다.
 */
describe("설정이 실제로 반영된다 (0013 회귀)", () => {
  it("export.max_per_lead 를 바꾸면 export 횟수 상한이 따라 바뀐다", async () => {
    const { candidate } = await candidateWithEmail();
    const [email] = await db.owner<Array<{ id: string }>>`
      select id from emails where company_id = ${candidate.companyId} limit 1
    `;
    await db.asUser(admin, (tx) => tx`
      select public.decide_review_item(${candidate.reviewItemId}, 'approved', null, ${email!.id}::uuid)
    `);

    // 상한 1 → 첫 export 는 나가고 두 번째는 후보에서 빠진다.
    await db.owner`update settings set value = '{"max_per_lead": 1}'::jsonb where key = 'export'`;

    const first = await db.asUser(admin, (tx) => tx<Array<{ export_leads: unknown }>>`
      select public.export_leads(current_date, current_date)
    `);
    expect(first.length).toBe(1);

    const second = await db.asUser(admin, (tx) => tx<Array<{ export_leads: unknown }>>`
      select public.export_leads(current_date, current_date)
    `);
    // 결함이 남아 있으면 상한이 3 이라 여기서 1건이 또 나간다.
    expect(second.length).toBe(0);

    const [row] = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from audit_log
      where action = 'leads.export' and (after ->> 'skipped_capped')::int = 1
    `;
    expect(row?.n).toBe("1");

    await db.owner`update settings set value = '{"max_per_lead": 3}'::jsonb where key = 'export'`;
    await db.owner`delete from leads`;
    await db.owner`delete from approval_counters`;
    await db.owner`delete from approval_day_totals`;
  });

  it("review.nonce_ttl_minutes 를 바꾸면 nonce 만료 시각이 따라 바뀐다", async () => {
    const { runId, attemptId } = await createRun(db);
    const candidate = await createCandidate(db, { runId, attemptId });

    await db.owner`
      update settings set value = jsonb_set(value, '{nonce_ttl_minutes}', '90') where key = 'review'
    `;
    const nonces = await db.asUser(admin, (tx) => tx<Array<{ issue_review_nonce: string }>>`
      select public.issue_review_nonce(${candidate.reviewItemId})
    `);
    const [row] = await db.owner<Array<{ mins: number }>>`
      select round(extract(epoch from (expires_at - issued_at)) / 60)::int as mins
      from review_view_nonces where nonce = ${nonces[0]!.issue_review_nonce}
    `;
    // 결함이 남아 있으면 항상 30 이다.
    expect(row?.mins).toBe(90);

    await db.owner`
      update settings set value = jsonb_set(value, '{nonce_ttl_minutes}', '30') where key = 'review'
    `;
  });

  it("❗ review.manual_email_per_minute 를 조이면 rate limit 이 실제로 조여진다 (보안 통제)", async () => {
    const { runId, attemptId } = await createRun(db);
    const candidate = await createCandidate(db, { runId, attemptId });

    await db.owner`
      update settings set value = jsonb_set(value, '{manual_email_per_minute}', '1') where key = 'review'
    `;
    await db.owner`delete from manual_entry_events`;

    const enter = async (address: string): Promise<void> => {
      const nonces = await db.asUser(admin, (tx) => tx<Array<{ issue_review_nonce: string }>>`
        select public.issue_review_nonce(${candidate.reviewItemId})
      `);
      await db.asUser(admin, (tx) => tx`
        select public.enter_contact_email(
          ${candidate.reviewItemId}, ${address}, 'inquiry',
          ${candidate.contactPageId}::uuid, ${nonces[0]!.issue_review_nonce})
      `);
    };

    await enter("first@example.kr");
    // 상한 1 이므로 두 번째는 거절돼야 한다. 결함이 남아 있으면 3까지 통과한다.
    await expect(enter("second@example.kr")).rejects.toThrow(/rate_limited/);

    await db.owner`
      update settings set value = jsonb_set(value, '{manual_email_per_minute}', '3') where key = 'review'
    `;
    await db.owner`delete from manual_entry_events`;
  });

  it("❗ 설정이 정수가 아니면 조용히 기본값으로 되돌아가지 않고 에러다", async () => {
    await db.owner`update settings set value = '{"max_per_lead": "셋"}'::jsonb where key = 'export'`;
    await expect(
      db.asUser(admin, (tx) => tx`select public.export_leads(current_date, current_date)`),
    ).rejects.toThrow(/configuration_error/);
    await db.owner`update settings set value = '{"max_per_lead": 3}'::jsonb where key = 'export'`;
  });

  it("setting_int 는 없는 키·필드에 NULL 을 준다 (호출자가 기본값을 정한다)", async () => {
    const [row] = await db.owner<Array<{ a: number | null; b: number | null }>>`
      select public.setting_int('nope', 'nope') as a, public.setting_int('review', 'nope') as b
    `;
    expect(row?.a).toBeNull();
    expect(row?.b).toBeNull();
  });
});

describe("스케줄 판정 — should_start_scheduled_run", () => {
  it("schedule.enabled 가 false 면 실행하지 않는다", async () => {
    await db.owner`update settings set value = jsonb_set(value, '{enabled}', 'false') where key = 'schedule'`;
    const [row] = await db.owner<Array<{ d: { should_run: boolean; reasons: string[] } }>>`
      select public.should_start_scheduled_run() as d
    `;
    expect(row!.d.should_run).toBe(false);
    expect(row!.d.reasons).toContain("schedule_disabled");

    await db.owner`update settings set value = jsonb_set(value, '{enabled}', 'true') where key = 'schedule'`;
  });

  it("❗ 같은 날 cron 실행이 이미 있으면 만들지 않는다", async () => {
    const [today] = await db.owner<Array<{ d: string }>>`
      select ((now() at time zone 'Asia/Seoul')::date)::text as d
    `;
    await db.owner`
      insert into runs (run_date, trigger, settings_snapshot)
      values (${today!.d}::date, 'cron', public.snapshot_settings())
    `;

    const [row] = await db.owner<Array<{ d: { should_run: boolean; reasons: string[]; existing_run_id: string | null } }>>`
      select public.should_start_scheduled_run() as d
    `;
    expect(row!.d.should_run).toBe(false);
    expect(row!.d.reasons).toContain("already_ran_today");
    expect(row!.d.existing_run_id).not.toBeNull();

    await db.owner`delete from runs where run_date = ${today!.d}::date and trigger = 'cron'`;
  });

  it("❗ 용량이 차단 레벨이면 스케줄도 멈춘다", async () => {
    const [cap] = await db.owner<Array<{ bytes: number }>>`
      select (public.db_capacity() ->> 'bytes')::bigint as bytes
    `;
    await db.owner`
      update settings set value = jsonb_set(value, '{limit_bytes}', to_jsonb((${cap!.bytes} / 0.95)::bigint))
      where key = 'capacity'
    `;
    const [row] = await db.owner<Array<{ d: { should_run: boolean; reasons: string[] } }>>`
      select public.should_start_scheduled_run() as d
    `;
    expect(row!.d.should_run).toBe(false);
    expect(row!.d.reasons).toContain("capacity_blocked");

    await db.owner`
      update settings set value = jsonb_set(value, '{limit_bytes}', to_jsonb(524288000::bigint))
      where key = 'capacity'
    `;
  });

  it("평일·설정 켜짐·중복 없음·용량 여유면 실행한다", async () => {
    const [row] = await db.owner<Array<{ d: { should_run: boolean; isodow: number; reasons: string[] } }>>`
      select public.should_start_scheduled_run() as d
    `;
    // 주말에 돌리면 not_a_weekday 가 정상이다 — 판정 근거를 함께 확인한다.
    if (row!.d.isodow > 5) {
      expect(row!.d.should_run).toBe(false);
      expect(row!.d.reasons).toEqual(["not_a_weekday"]);
    } else {
      expect(row!.d.should_run).toBe(true);
      expect(row!.d.reasons).toEqual([]);
    }
  });
});
