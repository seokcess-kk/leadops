import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./testDb";

/**
 * 스키마 린트 — 설계서 Phase 1 완료 기준.
 *
 * 이 파일의 쿼리들은 "선언"이 아니라 **실행 가능한 통제**다.
 * 정책이 하나라도 빠지면 여기서 빌드가 깨진다.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb("schema");
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("마이그레이션", () => {
  it("전부 적용된다", async () => {
    const rows = await db.owner<{ name: string }[]>`select name from _migrations order by name`;
    expect(rows.map((r) => r.name)).toEqual([
      "0000_local_bootstrap.sql",
      "0001_extensions_and_enums.sql",
      "0002_tables.sql",
      "0003_rls.sql",
      "0004_functions.sql",
      "0005_grants.sql",
      "0006_seed.sql",
      "0007_raw_candidates.sql",
      "0008_channel_saturation.sql",
      "0009_collection_scope.sql",
      "0010_verify_contact_email.sql",
      "0011_admin_rpcs.sql",
      "0012_ops_privacy_capacity.sql",
      "0013_fix_setting_paths.sql",
      "0014_homepage_discovery.sql",
      "0015_partition_observations.sql",
    ]);
  });

  it("두 번 적용해도 안전하다 (멱등)", async () => {
    const { migrate } = await import("./migrate");
    const applied = await migrate(db.owner, { bootstrap: true });
    expect(applied).toEqual([]);
  });

  it("설정 시드가 들어 있다", async () => {
    const rows = await db.owner<{ key: string }[]>`select key from settings order by key`;
    expect(rows.map((r) => r.key)).toContain("targets");
    expect(rows.map((r) => r.key)).toContain("privacy");
  });
});

describe("❗ P1 완료 기준: RLS 린트", () => {
  it("public 스키마의 모든 테이블(파티션 부모 포함)에 RLS 가 켜져 있다", async () => {
    // relkind='p' 는 파티션 부모(예: company_observations) — 파티션 자식은 'r' 로 이미 잡힌다.
    // 부모에 RLS 가 안 켜져 있으면 그 부모로의 직접 질의가 보호받지 못한다.
    const rows = await db.owner<{ relname: string }[]>`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity = false
      order by c.relname
    `;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("❗ authenticated 에 대한 INSERT/UPDATE/DELETE 정책이 하나도 없다", async () => {
    // v2 의 `WITH CHECK (true)` UPDATE 정책이 승인 상한을 통째로 우회시켰다.
    // 쓰기는 전부 SECURITY DEFINER RPC 를 거친다.
    const rows = await db.owner<{ polname: string; tbl: string }[]>`
      select p.polname, p.polrelid::regclass::text as tbl
      from pg_policy p
      where p.polcmd in ('a', 'w', 'd')
        and exists (
          select 1 from pg_roles r
          where r.oid = any (p.polroles) and r.rolname = 'authenticated'
        )
    `;
    expect(rows).toEqual([]);
  });

  it("❗ authenticated 에 INSERT/UPDATE/DELETE 권한(GRANT)이 없다", async () => {
    // 정책이 없어도 GRANT 가 남아 있으면 정책 실수 한 번에 뚫린다. 두 겹으로 막는다.
    const rows = await db.owner<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'authenticated'
        and table_schema = 'public'
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      order by table_name, privilege_type
    `;
    expect(rows).toEqual([]);
  });

  it("❗ 모든 SECURITY DEFINER 함수가 search_path 를 고정하고 PUBLIC 실행권이 없다", async () => {
    const rows = await db.owner<{ proname: string; issue: string }[]>`
      select p.proname,
             case
               when p.proconfig is null then 'search_path 미고정'
               when not ('search_path=public, pg_temp' = any (p.proconfig)) then 'search_path 값이 다름'
               else 'PUBLIC 실행권 보유'
             end as issue
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and (
          p.proconfig is null
          or not ('search_path=public, pg_temp' = any (p.proconfig))
          or has_function_privilege('public', p.oid, 'execute')
        )
      order by p.proname
    `;
    expect(rows).toEqual([]);
  });

  it("승인 카운터·nonce·캐시는 authenticated 에게 SELECT 조차 노출되지 않는다", async () => {
    const rows = await db.owner<{ table_name: string }[]>`
      select table_name
      from information_schema.role_table_grants
      where grantee = 'authenticated'
        and table_schema = 'public'
        and table_name in ('approval_counters', 'approval_day_totals', 'review_view_nonces',
                           'manual_entry_events', 'http_cache', 'outbox')
    `;
    expect(rows).toEqual([]);
  });

  it("❗ authenticated 는 MX 검증 함수를 실행할 수 없다 (승인 게이트 우회 차단)", async () => {
    // 이 함수를 주면 검수자가 스스로 mx_ok 를 참으로 만들 수 있고,
    // decide_review_item 의 `mx_ok is true` 조건이 무의미해진다.
    const rows = await db.owner<{ grantee: string }[]>`
      select grantee from information_schema.role_routine_grants
      where routine_name = 'verify_contact_email' and specific_schema = 'public'
        and grantee in ('authenticated', 'anon', 'PUBLIC')
    `;
    expect(rows).toEqual([]);
  });

  it("❗ 워커는 jobs 를 UPDATE 할 수 없다 (fencing 우회 차단)", async () => {
    const rows = await db.owner<{ privilege_type: string }[]>`
      select privilege_type
      from information_schema.role_table_grants
      where grantee = 'leadops_worker' and table_schema = 'public' and table_name = 'jobs'
      order by privilege_type
    `;
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT"]);
  });

  it("워커는 leads 에 쓸 수 없다 (리드는 승인 RPC 만 만든다)", async () => {
    const rows = await db.owner<{ privilege_type: string }[]>`
      select privilege_type
      from information_schema.role_table_grants
      where grantee = 'leadops_worker' and table_schema = 'public' and table_name = 'leads'
        and privilege_type <> 'SELECT'
    `;
    expect(rows).toEqual([]);
  });
});

describe("❗ 무결성 제약 (설계서 F-18 · R2-21 · R2-22)", () => {
  it("같은 날짜에 cron run 을 두 번 만들 수 없다", async () => {
    await db.owner`
      insert into runs (run_date, trigger, settings_snapshot)
      values ('2026-08-01'::date, 'cron', '{}'::jsonb)
    `;
    await expect(
      db.owner`
        insert into runs (run_date, trigger, settings_snapshot)
        values ('2026-08-01'::date, 'cron', '{}'::jsonb)
      `,
    ).rejects.toThrow(/runs_one_cron_per_day/);
  });

  it("같은 날짜의 manual run 은 여러 번 허용한다", async () => {
    for (let i = 0; i < 2; i++) {
      await db.owner`
        insert into runs (run_date, trigger, settings_snapshot)
        values ('2026-08-02'::date, 'manual', '{}'::jsonb)
      `;
    }
    const [row] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from runs where run_date = '2026-08-02'::date
    `;
    expect(row!.n).toBe("2");
  });

  it("❗ review_items 는 다른 attempt 의 score 를 참조할 수 없다 (단일 복합 FK)", async () => {
    const { createCandidate, createRun } = await import("./fixtures");
    const a = await createCandidate(db);
    const other = await createRun(db, "2026-08-03", "manual");
    const b = await createCandidate(db, { runId: other.runId, attemptId: other.attemptId });

    await expect(
      db.owner`
        update review_items set score_id = ${b.scoreId} where id = ${a.reviewItemId}
      `,
    ).rejects.toThrow(/review_items_score_id_attempt_id_company_id_fkey|foreign key/i);
  });

  it("❗ attempt 는 자기 run 소속이어야 한다", async () => {
    const r1 = await createRunRaw(db, "2026-08-04");
    const r2 = await createRunRaw(db, "2026-08-05");
    const [a1] = await db.owner<{ id: string }[]>`
      insert into run_attempts (run_id, attempt_no) values (${r1}, 1) returning id
    `;
    // r2 의 run_id 와 r1 의 attempt 를 조합하면 복합 FK 가 막아야 한다.
    const [company] = await db.owner<{ id: string }[]>`
      insert into companies (dedupe_key, name, normalized_name, industry)
      values (${`dk-x-${Math.random()}`}, 'x', 'x', 'derm') returning id
    `;
    await expect(
      db.owner`
        insert into scores (run_id, attempt_id, company_id, axis_problem, axis_propensity,
                            axis_confidence, total, breakdown, weaknesses, rule_version, gate_passed)
        values (${r2}, ${a1!.id}, ${company!.id}, 1, 1, 1, 3, '{}'::jsonb, '[]'::jsonb, 'v', false)
      `,
    ).rejects.toThrow(/foreign key|scores_attempt_id_run_id_fkey/i);
  });

  it("❗ 연락처 페이지의 본문을 가져왔다고 표시할 수 없다 (제50조의2 방어선)", async () => {
    const { createCandidate } = await import("./fixtures");
    const c = await createCandidate(db);
    await expect(
      db.owner`update contact_pages set body_fetched = true where id = ${c.contactPageId}`,
    ).rejects.toThrow(/contact_body_never_fetched/);
  });

  it("❗ manual_entry 이메일은 행위자·시각·본 페이지가 없으면 저장되지 않는다", async () => {
    const { createCandidate } = await import("./fixtures");
    const c = await createCandidate(db);
    await expect(
      db.owner`
        insert into emails (company_id, address, local_part, domain, acquisition_method,
                            collection_legal_basis, is_personal_data, retention_until)
        values (${c.companyId}, 'a@b.kr', 'a', 'b.kr', 'manual_entry',
                'manual_from_public_site', false, current_date + 1)
      `,
    ).rejects.toThrow(/manual_needs_evidence/);
  });

  it("acquisition_method 에 'scraped' 값 자체가 존재하지 않는다", async () => {
    const rows = await db.owner<{ label: string }[]>`
      select unnest(enum_range(null::acquisition_method))::text as label
    `;
    expect(rows.map((r) => r.label)).toEqual(["manual_entry", "public_api"]);
  });

  it("http_cache 발췌는 4KB 를 넘길 수 없다", async () => {
    await expect(
      db.owner`
        insert into http_cache (cache_key, body_excerpt, fetched_at, expires_at)
        values ('k', ${"A".repeat(5000)}, now(), now() + interval '1 day')
      `,
    ).rejects.toThrow(/body_excerpt/);
  });
});

async function createRunRaw(db: TestDb, date: string): Promise<string> {
  const [row] = await db.owner<{ id: string }[]>`
    insert into runs (run_date, trigger, settings_snapshot)
    values (${date}::date, 'manual', public.snapshot_settings())
    returning id
  `;
  return row!.id;
}
