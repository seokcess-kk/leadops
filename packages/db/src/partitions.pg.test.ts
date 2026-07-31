import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./testDb";

/**
 * 관측 테이블 월 단위 파티셔닝 (설계서 4.2 P7 완료 기준).
 *
 * ❗ 이 테스트의 존재 이유는 "재시도 upsert 멱등성이 파티셔닝 후에도 DB 제약으로
 *    유지된다"이다. run_date 는 재시도에 불변이므로 conflict 가 기존과 동일하게 발화해야 한다.
 */

const PARENTS = [
  "search_aggregates",
  "company_observations",
  "website_observations",
  "channel_observations",
] as const;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb("partitions");
}, 120_000);

afterAll(async () => {
  await db.close();
});

/** 오늘(UTC) 기준 n개월 이동한 달의 1일. */
function monthStart(offset: number): { iso: string; name: string } {
  const d = new Date();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
  const iso = m.toISOString().slice(0, 10);
  const name = `y${m.getUTCFullYear()}m${String(m.getUTCMonth() + 1).padStart(2, "0")}`;
  return { iso, name };
}

async function seedAttempt(runDate: string): Promise<{ attemptId: string; companyId: string }> {
  const [run] = await db.owner<{ id: string }[]>`
    insert into runs (run_date, trigger, settings_snapshot)
    values (${runDate}::date, 'manual', public.snapshot_settings()) returning id
  `;
  const [attempt] = await db.owner<{ id: string }[]>`
    insert into run_attempts (run_id, attempt_no) values (${run!.id}, 1) returning id
  `;
  const suffix = Math.random().toString(36).slice(2, 10);
  const [company] = await db.owner<{ id: string }[]>`
    insert into companies (dedupe_key, name, normalized_name, industry, region_sido)
    values (${`pk-${suffix}`}, ${`파티션${suffix}`}, ${`파티션${suffix}`}, 'derm', '서울특별시')
    returning id
  `;
  return { attemptId: attempt!.id, companyId: company!.id };
}

describe("파티션 스키마", () => {
  it("관측 4테이블이 파티션 부모다 (relkind='p')", async () => {
    const rows = await db.owner<{ relname: string }[]>`
      select relname from pg_class
      where relname = any(${PARENTS as unknown as string[]}) and relkind = 'p'
      order by relname
    `;
    expect(rows.map((r) => r.relname).sort()).toEqual([...PARENTS].sort());
  });

  it("PK·FK·CHECK 제약 이름이 정규형이다 (1 접미 없음)", async () => {
    for (const table of PARENTS) {
      const rows = await db.owner<{ conname: string }[]>`
        select conname from pg_constraint
        where conrelid = ${table}::regclass
        order by conname
      `;
      const names = rows.map((r) => r.conname);
      // 1 접미가 붙은 제약이 하나도 없음을 확인 (denominator_nonneg 는 예외)
      const hasInvalidSuffix = names.some((n) => /1$/.test(n));
      expect(hasInvalidSuffix, `${table}에서 "1" 접미 제약 발견: ${names.join(", ")}`).toBe(
        false,
      );
      // 정규형 PK가 존재함을 확인
      expect(names).toContain(`${table}_pkey`);
    }
  });

  it("현재 달부터 +2개월 파티션이 존재하고 전부 RLS 가 켜져 있다", async () => {
    for (const parent of PARENTS) {
      for (const offset of [0, 1, 2]) {
        const { name } = monthStart(offset);
        const rows = await db.owner<{ relrowsecurity: boolean }[]>`
          select relrowsecurity from pg_class where relname = ${`${parent}_${name}`} and relkind = 'r'
        `;
        expect(rows, `${parent}_${name} 이 없다`).toHaveLength(1);
        expect(rows[0]!.relrowsecurity).toBe(true);
      }
    }
  });

  it("run_date 없는 insert 는 에러다 (default 부재 — 조용한 오라우팅 방지)", async () => {
    const { attemptId, companyId } = await seedAttempt(monthStart(0).iso);
    await expect(
      db.owner`
        insert into company_observations (company_id, attempt_id, status, track)
        values (${companyId}, ${attemptId}, 'active', 'new')
      `,
    ).rejects.toThrow(/null value|no partition/);
  });
});

describe("재시도 멱등성 — 같은 attempt 의 재삽입이 중복을 만들지 않는다", () => {
  it("company_observations: unique (company_id, attempt_id, run_date) upsert 유지", async () => {
    const runDate = monthStart(0).iso;
    const { attemptId, companyId } = await seedAttempt(runDate);
    for (let i = 0; i < 2; i++) {
      await db.owner`
        insert into company_observations (company_id, attempt_id, run_date, status, track)
        values (${companyId}, ${attemptId}, ${runDate}::date, 'active', ${i === 0 ? "new" : "changed"})
        on conflict (company_id, attempt_id, run_date) do update set track = excluded.track
      `;
    }
    const rows = await db.owner<{ track: string }[]>`
      select track from company_observations where company_id = ${companyId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.track).toBe("changed");
  });

  it("search_aggregates: unique (attempt_id, company_id, keyword, provider, run_date) upsert 유지 · id 시퀀스 동작", async () => {
    const runDate = monthStart(0).iso;
    const { attemptId, companyId } = await seedAttempt(runDate);
    for (let i = 0; i < 2; i++) {
      await db.owner`
        insert into search_aggregates (
          attempt_id, company_id, run_date, keyword, keyword_kind, provider,
          total_returned, denominator, related_count, official_count, classifier_version
        ) values (
          ${attemptId}, ${companyId}, ${runDate}::date, '강남 피부과', 'nonbrand', 'naver_blog',
          ${10 + i}, 10, 3, 1, 'v1'
        )
        on conflict (attempt_id, company_id, keyword, provider, run_date) do update set
          total_returned = excluded.total_returned
      `;
    }
    const rows = await db.owner<{ id: string; total_returned: number }[]>`
      select id, total_returned from search_aggregates where company_id = ${companyId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.total_returned).toBe(11);
  });

  it("website_observations · channel_observations: upsert 유지", async () => {
    const runDate = monthStart(0).iso;
    const { attemptId, companyId } = await seedAttempt(runDate);
    const [site] = await db.owner<{ id: string }[]>`
      insert into websites (company_id, canonical_url, domain)
      values (${companyId}, 'https://pk.example.kr', 'pk.example.kr') returning id
    `;
    for (let i = 0; i < 2; i++) {
      await db.owner`
        insert into website_observations (website_id, attempt_id, run_date, official_status, crawled_pages)
        values (${site!.id}, ${attemptId}, ${runDate}::date, 'likely', ${i})
        on conflict (website_id, attempt_id, run_date) do update set crawled_pages = excluded.crawled_pages
      `;
    }
    const sites = await db.owner<{ crawled_pages: number }[]>`
      select crawled_pages from website_observations where website_id = ${site!.id}
    `;
    expect(sites).toHaveLength(1);
    expect(sites[0]!.crawled_pages).toBe(1);

    const [channel] = await db.owner<{ id: string }[]>`
      insert into channels (company_id, type, url)
      values (${companyId}, 'thirdparty_blog', 'https://blog.example.kr/pk') returning id
    `;
    for (let i = 0; i < 2; i++) {
      await db.owner`
        insert into channel_observations (channel_id, attempt_id, run_date, is_active, posts_60d)
        values (${channel!.id}, ${attemptId}, ${runDate}::date, true, ${i})
        on conflict (channel_id, attempt_id, run_date) do update set posts_60d = excluded.posts_60d
      `;
    }
    const chans = await db.owner<{ posts_60d: number }[]>`
      select posts_60d from channel_observations where channel_id = ${channel!.id}
    `;
    expect(chans).toHaveLength(1);
    expect(chans[0]!.posts_60d).toBe(1);
  });
});

describe("search_hits 복합 FK", () => {
  it("search_aggregates 삭제가 search_hits 로 cascade 된다", async () => {
    const runDate = monthStart(0).iso;
    const { attemptId, companyId } = await seedAttempt(runDate);
    const [agg] = await db.owner<{ id: string }[]>`
      insert into search_aggregates (
        attempt_id, company_id, run_date, keyword, keyword_kind, provider,
        total_returned, denominator, related_count, official_count, classifier_version
      ) values (
        ${attemptId}, ${companyId}, ${runDate}::date, '역삼 치과', 'nonbrand', 'naver_blog',
        5, 5, 2, 0, 'v1'
      ) returning id
    `;
    await db.owner`
      insert into search_hits (
        aggregate_id, run_date, attempt_id, company_id, keyword, rank,
        channel_type, url, url_hash
      ) values (
        ${agg!.id}, ${runDate}::date, ${attemptId}, ${companyId}, '역삼 치과', 1,
        'thirdparty_blog', 'https://blog.example.kr/1', 'hash-pk-1'
      )
    `;
    await db.owner`delete from search_aggregates where id = ${agg!.id} and run_date = ${runDate}::date`;
    const hits = await db.owner<{ id: string }[]>`
      select id from search_hits where url_hash = 'hash-pk-1'
    `;
    expect(hits).toHaveLength(0);
  });
});

describe("run_attempts cascade", () => {
  it("run_attempts 삭제가 company_observations 로 cascade 된다 (스펙 테스트 §5)", async () => {
    const runDate = monthStart(0).iso;
    const { attemptId, companyId } = await seedAttempt(runDate);
    await db.owner`
      insert into company_observations (company_id, attempt_id, run_date, status, track)
      values (${companyId}, ${attemptId}, ${runDate}::date, 'active', 'new')
    `;
    await db.owner`delete from run_attempts where id = ${attemptId}`;
    const rows = await db.owner<{ id: string }[]>`
      select id from company_observations where attempt_id = ${attemptId}
    `;
    expect(rows).toHaveLength(0);
  });
});

describe("maintain_observation_partitions()", () => {
  it("365일 초과 파티션을 drop 하고 반환 jsonb 에 남긴다 · 선생성은 멱등", async () => {
    // 만료 파티션을 직접 만들어 둔다 (25개월 전 — 상한도 365일 초과).
    const old = monthStart(-25);
    const oldNext = monthStart(-24);
    await db.owner.unsafe(
      `create table company_observations_${old.name} partition of company_observations
       for values from ('${old.iso}') to ('${oldNext.iso}')`,
    );
    await db.owner.unsafe(`alter table company_observations_${old.name} enable row level security`);

    const [row] = await db.owner<
      { maintain_observation_partitions: { created: string[]; dropped: string[]; errors: string[] } }[]
    >`
      select public.maintain_observation_partitions()
    `;
    const result = row!.maintain_observation_partitions;
    expect(result.dropped.join(",")).toContain(`company_observations_${old.name}`);
    expect(result.errors).toEqual([]);

    const gone = await db.owner<{ relname: string }[]>`
      select relname from pg_class where relname = ${`company_observations_${old.name}`}
    `;
    expect(gone).toHaveLength(0);

    // 두 번째 호출: 이미 다 있으므로 아무것도 만들지도 지우지도 않는다.
    const [again] = await db.owner<
      { maintain_observation_partitions: { created: string[]; dropped: string[]; errors: string[] } }[]
    >`
      select public.maintain_observation_partitions()
    `;
    expect(again!.maintain_observation_partitions.created).toEqual([]);
    expect(again!.maintain_observation_partitions.dropped).toEqual([]);
    expect(again!.maintain_observation_partitions.errors).toEqual([]);
  });

  it("worker 는 실행할 수 있고 authenticated 는 실행할 수 없다", async () => {
    await expect(
      db.asWorker(async (tx) => tx`select public.maintain_observation_partitions()`),
    ).resolves.toBeDefined();
    const { attemptId } = await seedAttempt(monthStart(0).iso);
    void attemptId;
    const [user] = await db.owner<{ id: string }[]>`
      insert into auth.users (email) values ('partition-test@example.kr') returning id
    `;
    await expect(
      db.asUser(user!.id, async (tx) => tx`select public.maintain_observation_partitions()`),
    ).rejects.toThrow(/permission denied/);
  });

  it("cleanup_by_capacity() 가 파티션 유지 결과를 포함한다", async () => {
    const result = await db.asWorker(async (tx) => {
      const [row] = await tx<{ cleanup_by_capacity: Record<string, unknown> }[]>`
        select public.cleanup_by_capacity()
      `;
      return row!.cleanup_by_capacity;
    });
    expect(result["partitions"]).toBeDefined();
  });
});
