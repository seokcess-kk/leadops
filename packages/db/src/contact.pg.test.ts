import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCandidate, createRun, createVerifiedEmail, type Candidate } from "./fixtures";
import { createTestDb, createUser, type TestDb } from "./testDb";

/**
 * 연락처 수동 입력과 export 게이트.
 *
 * 설계서 결론 A: 홈페이지에서 프로그램으로 이메일을 수집하지 않는다.
 * 검수자가 페이지를 직접 열어 보고 입력하며, 함수가 그 사실을 증거로 결속한다(R2-08).
 */

let db: TestDb;
let userId: string;
let adminId: string;

beforeAll(async () => {
  db = await createTestDb("contact");
  userId = await createUser(db, "reviewer@example.kr", "user");
  adminId = await createUser(db, "boss@example.kr", "admin");
}, 60_000);

afterAll(async () => {
  await db?.close();
});

/**
 * 테스트마다 새 검수자를 쓴다.
 *
 * `enter_contact_email` 은 분당 입력 횟수를 사용자 단위로 제한하므로(R2-08),
 * 여러 테스트가 한 사용자를 공유하면 뒤 테스트가 rate limit 에 걸린다.
 * 그 제한을 검증하는 테스트만 의도적으로 한 사용자를 반복 사용한다.
 */
let userSeq = 0;
const freshUser = (): Promise<string> =>
  createUser(db, `reviewer${++userSeq}-${Date.now().toString(36)}@example.kr`, "user");

const nonceFor = async (actor: string, itemId: string): Promise<string> => {
  const rows = await db.asUser(
    actor,
    (tx) => tx<{ issue_review_nonce: string }[]>`select public.issue_review_nonce(${itemId}::uuid)`,
  );
  return rows[0]!.issue_review_nonce;
};

const enter = (actor: string, cand: Candidate, address: string, nonce: string, pageId?: string) =>
  db.asUser(
    actor,
    (tx) => tx`select public.enter_contact_email(
      ${cand.reviewItemId}::uuid, ${address}, 'inquiry'::email_type,
      ${pageId ?? cand.contactPageId}::uuid, ${nonce}) as r`,
  );

describe("enter_contact_email — 정상 흐름", () => {
  it("검수자가 입력한 이메일이 증거와 함께 저장된다", async () => {
    const reviewer = await freshUser();
    const c = await createCandidate(db);
    const nonce = await nonceFor(reviewer, c.reviewItemId);
    await enter(reviewer, c, "contact@clinic.kr", nonce);

    const [row] = await db.owner<
      {
        acquisition_method: string;
        collection_legal_basis: string;
        entered_by: string;
        source_contact_page_id: string;
        syntax_ok: boolean;
        mx_ok: boolean | null;
      }[]
    >`select acquisition_method, collection_legal_basis, entered_by,
             source_contact_page_id, syntax_ok, mx_ok
      from emails where company_id = ${c.companyId}`;

    expect(row!.acquisition_method).toBe("manual_entry");
    expect(row!.collection_legal_basis).toBe("manual_from_public_site");
    expect(row!.entered_by).toBe(reviewer);
    expect(row!.source_contact_page_id).toBe(c.contactPageId);
    expect(row!.syntax_ok).toBe(true);
    // MX 는 워커가 비동기로 채운다. 입력만으로는 승인 게이트를 통과하지 못한다.
    expect(row!.mx_ok).toBeNull();
  });

  it("도메인 일치와 무료메일 여부를 판정한다", async () => {
    const reviewer = await freshUser();
    const c = await createCandidate(db);
    const [site] = await db.owner<{ domain: string }[]>`
      select domain from websites where id = ${c.websiteId}
    `;
    await enter(reviewer, c, `info@${site!.domain}`, await nonceFor(reviewer, c.reviewItemId));

    const c2 = await createCandidate(db);
    await enter(reviewer, c2, "owner@naver.com", await nonceFor(reviewer, c2.reviewItemId));

    const [a] = await db.owner<{ domain_match: boolean }[]>`
      select domain_match from emails where company_id = ${c.companyId}
    `;
    const [b] = await db.owner<{ is_free_mail: boolean }[]>`
      select is_free_mail from emails where company_id = ${c2.companyId}
    `;
    expect(a!.domain_match).toBe(true);
    expect(b!.is_free_mail).toBe(true);
  });

  it("감사 로그를 남긴다", async () => {
    const reviewer = await freshUser();
    const c = await createCandidate(db);
    await enter(reviewer, c, "log@clinic.kr", await nonceFor(reviewer, c.reviewItemId));
    const [row] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from audit_log where action = 'email.manual_entry'
    `;
    expect(Number(row!.n)).toBeGreaterThan(0);
  });

  it("❗ 같은 주소를 다른 사람이 재입력하면 증거가 최신 행위자로 갱신된다", async () => {
    // 증거 없는 manual_entry 행은 CHECK 제약(manual_needs_evidence) 때문에 애초에
    // 존재할 수 없다. 따라서 검증할 것은 "증거가 비어 있다가 채워지는가" 가 아니라
    // "재입력 시 옛 행위자가 그대로 남지 않는가" 다.
    const first = await freshUser();
    const second = await freshUser();
    const c = await createCandidate(db);

    await enter(first, c, "dup@clinic.kr", await nonceFor(first, c.reviewItemId));
    const [before] = await db.owner<{ entered_by: string; entered_at: Date }[]>`
      select entered_by, entered_at from emails where company_id = ${c.companyId}
    `;
    expect(before!.entered_by).toBe(first);

    await enter(second, c, "dup@clinic.kr", await nonceFor(second, c.reviewItemId));
    const [after] = await db.owner<{ entered_by: string; entered_at: Date; n: string }[]>`
      select entered_by, entered_at, (select count(*)::text from emails where company_id = ${c.companyId}) as n
      from emails where company_id = ${c.companyId}
    `;
    expect(after!.entered_by).toBe(second);
    expect(after!.entered_at.getTime()).toBeGreaterThanOrEqual(before!.entered_at.getTime());
    expect(after!.n).toBe("1"); // 중복 행이 생기지 않는다
  });

  it("❗ 증거 없는 manual_entry 행은 존재할 수 없다 (CHECK 제약)", async () => {
    const c = await createCandidate(db);
    const reviewer = await freshUser();
    await enter(reviewer, c, "evidence@clinic.kr", await nonceFor(reviewer, c.reviewItemId));
    await expect(
      db.owner`update emails set entered_by = null where company_id = ${c.companyId}`,
    ).rejects.toThrow(/manual_needs_evidence/);
  });
});

describe("❗ enter_contact_email — 자동화 방어 (R2-08)", () => {
  it("nonce 없이는 입력할 수 없다", async () => {
    const c = await createCandidate(db);
    await expect(enter(userId, c, "x@y.kr", "made-up-nonce")).rejects.toThrow(/invalid_nonce/);
  });

  it("nonce 는 1회용이다", async () => {
    const reviewer = await freshUser();
    const c = await createCandidate(db);
    const nonce = await nonceFor(reviewer, c.reviewItemId);
    await enter(reviewer, c, "first@y.kr", nonce);
    await expect(enter(reviewer, c, "second@y.kr", nonce)).rejects.toThrow(/invalid_nonce/);
  });

  it("다른 사람의 nonce 를 쓸 수 없다", async () => {
    const c = await createCandidate(db);
    const nonce = await nonceFor(adminId, c.reviewItemId);
    await expect(enter(userId, c, "x@y.kr", nonce)).rejects.toThrow(/invalid_nonce/);
  });

  it("다른 검수 항목의 nonce 를 쓸 수 없다", async () => {
    const a = await createCandidate(db);
    const b = await createCandidate(db);
    const nonce = await nonceFor(userId, a.reviewItemId);
    await expect(enter(userId, b, "x@y.kr", nonce)).rejects.toThrow(/invalid_nonce/);
  });

  it("만료된 nonce 는 거부된다", async () => {
    const c = await createCandidate(db);
    const nonce = await nonceFor(userId, c.reviewItemId);
    await db.owner`update review_view_nonces set expires_at = now() - interval '1 minute' where nonce = ${nonce}`;
    await expect(enter(userId, c, "x@y.kr", nonce)).rejects.toThrow(/invalid_nonce/);
  });

  it("❗ 다른 업체의 연락처 페이지를 지정할 수 없다", async () => {
    const a = await createCandidate(db);
    const b = await createCandidate(db);
    const nonce = await nonceFor(userId, a.reviewItemId);
    await expect(enter(userId, a, "x@y.kr", nonce, b.contactPageId)).rejects.toThrow(
      /page_company_mismatch/,
    );
  });

  it("문법이 틀린 주소를 거부한다", async () => {
    const c = await createCandidate(db);
    for (const bad of ["없음", "a@b", "a b@c.kr", "@c.kr", "a@"]) {
      const nonce = await nonceFor(userId, c.reviewItemId);
      await expect(enter(userId, c, bad, nonce), bad).rejects.toThrow(/invalid_syntax/);
    }
  });

  it("❗ 분당 입력 횟수를 제한한다 (대량 자동 호출 차단)", async () => {
    const limiter = await createUser(db, "limiter@example.kr", "user");
    const cands = await Promise.all([0, 1, 2, 3].map(() => createCandidate(db)));

    for (let i = 0; i < 3; i++) {
      const c = cands[i]!;
      await enter(limiter, c, `ok${i}@clinic.kr`, await nonceFor(limiter, c.reviewItemId));
    }
    const last = cands[3]!;
    await expect(
      enter(limiter, last, "over@clinic.kr", await nonceFor(limiter, last.reviewItemId)),
    ).rejects.toThrow(/rate_limited/);
  });

  it("비인증 호출을 거부한다", async () => {
    const c = await createCandidate(db);
    await expect(
      db.asAnon(
        (tx) => tx`select public.enter_contact_email(
          ${c.reviewItemId}::uuid, 'x@y.kr', 'inquiry'::email_type, ${c.contactPageId}::uuid, 'n')`,
      ),
    ).rejects.toThrow(/permission denied|unauthenticated/i);
  });
});

describe("❗ export_leads — 접촉 근거 게이트 (R2-03)", () => {
  /** 승인된 리드 하나를 만든다. */
  async function approvedLead(industry = "derm"): Promise<{ cand: Candidate; leadId: string }> {
    const { runId, attemptId } = await createRun(db, "2026-10-01", "manual");
    const cand = await createCandidate(db, { industry, runId, attemptId });
    const emailId = await createVerifiedEmail(db, cand, userId);
    await db.asUser(
      userId,
      (tx) => tx`select public.decide_review_item(
        ${cand.reviewItemId}::uuid, 'approved'::review_status, null, ${emailId}::uuid)`,
    );
    const [lead] = await db.owner<{ id: string }[]>`
      select id from leads where review_item_id = ${cand.reviewItemId}
    `;
    return { cand, leadId: lead!.id };
  }

  const exportAs = (actor: string) =>
    db.asUser(actor, (tx) => tx<{ export_leads: Record<string, unknown> }[]>`
      select public.export_leads('2026-01-01'::date, '2027-01-01'::date)
    `);

  it("일반 사용자는 export 할 수 없다", async () => {
    await expect(exportAs(userId)).rejects.toThrow(/forbidden/);
  });

  it("승인된 리드를 워터마크와 함께 내보낸다", async () => {
    await db.owner`delete from leads`;
    await approvedLead();
    const rows = await exportAs(adminId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!.export_leads;
    expect(row).toHaveProperty("email");
    expect(row).toHaveProperty("_watermark");
  });

  it("❗ 접촉 근거가 pending 이면 내보내지 않는다", async () => {
    await db.owner`delete from leads`;
    const { leadId } = await approvedLead();
    await db.asUser(
      adminId,
      (tx) => tx`select public.set_contact_basis(${leadId}::uuid, 'pending_legal_review'::contact_basis, '보류')`,
    );
    expect(await exportAs(adminId)).toHaveLength(0);
  });

  it("❗ 접촉 불가로 지정된 리드는 내보내지 않는다", async () => {
    await db.owner`delete from leads`;
    const { leadId } = await approvedLead();
    await db.asUser(
      adminId,
      (tx) => tx`select public.set_contact_basis(${leadId}::uuid, 'not_permitted'::contact_basis, '차단')`,
    );
    expect(await exportAs(adminId)).toHaveLength(0);
  });

  it("❗ 수신거부(do_not_contact) 업체는 어떤 근거가 있어도 제외된다", async () => {
    await db.owner`delete from leads`;
    const { cand } = await approvedLead();
    await db.owner`update companies set do_not_contact = true where id = ${cand.companyId}`;
    expect(await exportAs(adminId)).toHaveLength(0);
  });

  it("❗ 개인정보 처리 요청이 진행 중이면 제외된다", async () => {
    await db.owner`delete from leads`;
    const { cand } = await approvedLead();
    await db.owner`
      insert into privacy_requests (kind, subject_identifier, company_id, status, due_at)
      values ('delete', 'x', ${cand.companyId}, 'received', now() + interval '10 days')
    `;
    expect(await exportAs(adminId)).toHaveLength(0);
  });

  it("보유기간이 지난 리드는 제외된다", async () => {
    await db.owner`delete from leads`;
    const { leadId } = await approvedLead();
    await db.owner`update leads set retention_until = current_date - 1 where id = ${leadId}`;
    expect(await exportAs(adminId)).toHaveLength(0);
  });

  it("MX 검증을 통과하지 않은 이메일의 리드는 제외된다", async () => {
    await db.owner`delete from leads`;
    const { leadId } = await approvedLead();
    await db.owner`
      update emails set mx_ok = false
      where id = (select email_id from leads where id = ${leadId})
    `;
    expect(await exportAs(adminId)).toHaveLength(0);
  });

  it("❗ 다운로드 횟수 상한에 도달한 리드는 제외된다 (S-02)", async () => {
    await db.owner`delete from leads`;
    await approvedLead();
    expect(await exportAs(adminId)).toHaveLength(1);
    expect(await exportAs(adminId)).toHaveLength(1);
    expect(await exportAs(adminId)).toHaveLength(1);
    // 상한 도달 — 예외를 던지지 않고 후보에서 빠진다.
    expect(await exportAs(adminId)).toHaveLength(0);
  });

  it("❗ 상한에 걸린 리드 하나가 나머지 export 를 막지 않는다", async () => {
    await db.owner`delete from leads`;
    const capped = await approvedLead("derm");
    await db.owner`update leads set export_count = 3 where id = ${capped.leadId}`;
    await approvedLead("dental");

    // 예외 없이, 아직 상한에 닿지 않은 리드만 나온다.
    expect(await exportAs(adminId)).toHaveLength(1);
  });

  it("제외된 건수를 감사 로그에 남긴다 (조용한 누락 방지)", async () => {
    await db.owner`delete from leads`;
    await db.owner`delete from audit_log where action = 'leads.export'`;
    const { leadId } = await approvedLead();
    await db.owner`update leads set export_count = 3 where id = ${leadId}`;

    await exportAs(adminId);
    const [row] = await db.owner<{ after: { count: number; skipped_capped: number } }[]>`
      select after from audit_log where action = 'leads.export' order by id desc limit 1
    `;
    expect(row!.after.count).toBe(0);
    expect(row!.after.skipped_capped).toBe(1);
  });

  it("export 는 감사 로그를 남긴다", async () => {
    await db.owner`delete from leads`;
    await db.owner`delete from audit_log where action = 'leads.export'`;
    await approvedLead();
    await exportAs(adminId);
    const [row] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from audit_log where action = 'leads.export'
    `;
    expect(Number(row!.n)).toBe(1);
  });
});
