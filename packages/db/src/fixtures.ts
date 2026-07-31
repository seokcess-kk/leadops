import type { TestDb } from "./testDb";

/** 통합 테스트용 최소 데이터 세트. 실제 파이프라인이 만들 모양과 같게 유지한다. */

/**
 * 오늘(UTC) 기준 상대 날짜 (YYYY-MM-DD).
 *
 * ❗ pg 테스트가 절대 날짜를 하드코딩하면 파티션 창(현재 달~+2개월) 밖으로 밀려나
 *    달력이 흐르면 깨진다. 관측 테이블에 닿는 날짜는 이것으로 만든다.
 */
export function relativeDate(daysFromToday: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

export interface Candidate {
  companyId: string;
  runId: string;
  attemptId: string;
  scoreId: string;
  reviewItemId: string;
  websiteId: string;
  contactPageId: string;
}

/**
 * ❗ 기본 trigger 는 'manual' 이다.
 *    `runs_one_cron_per_day` 부분 유일 인덱스 때문에 cron run 은 날짜당 하나뿐이라,
 *    픽스처 기본값으로 두면 두 번째 호출부터 충돌한다. (그 제약을 검증하는 테스트는
 *    trigger 를 명시적으로 'cron' 으로 넘긴다.)
 */
export async function createRun(
  db: TestDb,
  // ❗ 고정 날짜를 쓰지 않는다. 파티션은 현재 달 기준으로 만들어지므로 고정 날짜는
  //    시간이 지나면 파티션 밖(또는 만료 대상)이 되어 테스트가 달력에 따라 깨진다.
  runDate = new Date().toISOString().slice(0, 10),
  trigger = "manual",
): Promise<{ runId: string; attemptId: string; runDate: string }> {
  const [run] = await db.owner<{ id: string }[]>`
    insert into runs (run_date, trigger, settings_snapshot)
    values (${runDate}::date, ${trigger}, public.snapshot_settings())
    returning id
  `;
  const runId = run!.id;
  const [attempt] = await db.owner<{ id: string }[]>`
    insert into run_attempts (run_id, attempt_no) values (${runId}, 1) returning id
  `;
  return { runId, attemptId: attempt!.id, runDate };
}

export interface CandidateOptions {
  industry?: string;
  name?: string;
  rank?: number;
  total?: number;
  runId?: string;
  attemptId?: string;
  /** 기존 업체를 재사용한다 (재실행 attempt 시나리오 등). */
  companyId?: string;
}

export async function createCandidate(db: TestDb, options: CandidateOptions = {}): Promise<Candidate> {
  const industry = options.industry ?? "derm";
  const suffix = Math.random().toString(36).slice(2, 10);
  const name = options.name ?? `테스트${industry}${suffix}`;

  let runId = options.runId;
  let attemptId = options.attemptId;
  if (!runId || !attemptId) {
    const r = await createRun(db);
    runId = r.runId;
    attemptId = r.attemptId;
  }

  let companyId = options.companyId;
  if (!companyId) {
    const [company] = await db.owner<{ id: string }[]>`
      insert into companies (dedupe_key, name, normalized_name, industry, region_sido)
      values (${`dk-${suffix}`}, ${name}, ${name}, ${industry}, '서울특별시')
      returning id
    `;
    companyId = company!.id;
  }

  const [website] = await db.owner<{ id: string }[]>`
    insert into websites (company_id, canonical_url, domain)
    values (${companyId}, ${`https://ex-${suffix}.kr`}, ${`ex-${suffix}.kr`})
    returning id
  `;
  const websiteId = website!.id;

  const [page] = await db.owner<{ id: string }[]>`
    insert into contact_pages (website_id, attempt_id, url, page_kind, link_text, confidence)
    values (${websiteId}, ${attemptId}, ${`https://ex-${suffix}.kr/contact`}, 'contact', '문의하기', 0.9)
    returning id
  `;
  const contactPageId = page!.id;

  const [score] = await db.owner<{ id: string }[]>`
    insert into scores (
      run_id, attempt_id, company_id,
      axis_problem, axis_propensity, axis_confidence, total,
      breakdown, weaknesses, competitor_gap_available, rule_version, gate_passed
    )
    values (
      ${runId}, ${attemptId}, ${companyId},
      20, 14, 11, ${options.total ?? 72},
      '{}'::jsonb, '[]'::jsonb, true, 'v3-test', true
    )
    returning id
  `;
  const scoreId = score!.id;

  const [item] = await db.owner<{ id: string }[]>`
    insert into review_items (run_id, attempt_id, company_id, score_id, rank)
    values (${runId}, ${attemptId}, ${companyId}, ${scoreId}, ${options.rank ?? 1})
    returning id
  `;

  return {
    companyId,
    runId,
    attemptId,
    scoreId,
    reviewItemId: item!.id,
    websiteId,
    contactPageId,
  };
}

/** MX 검증까지 통과한 이메일을 만든다 (승인 게이트를 통과할 수 있는 상태). */
export async function createVerifiedEmail(
  db: TestDb,
  candidate: Candidate,
  enteredBy: string,
  address?: string,
): Promise<string> {
  const addr = address ?? `contact-${Math.random().toString(36).slice(2, 8)}@example.kr`;
  const [row] = await db.owner<{ id: string }[]>`
    insert into emails (
      company_id, address, local_part, domain, email_type,
      acquisition_method, collection_legal_basis,
      entered_by, entered_at, source_contact_page_id,
      syntax_ok, dns_ok, mx_ok, verified_at,
      is_personal_data, retention_until
    )
    values (
      ${candidate.companyId}, ${addr},
      ${addr.split("@")[0]!}, ${addr.split("@")[1]!}, 'inquiry',
      'manual_entry', 'manual_from_public_site',
      ${enteredBy}, now(), ${candidate.contactPageId},
      true, true, true, now(),
      false, current_date + 365
    )
    returning id
  `;
  return row!.id;
}
