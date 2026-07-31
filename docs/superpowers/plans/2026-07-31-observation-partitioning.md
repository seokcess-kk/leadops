# 관측 테이블 월 단위 파티셔닝 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관측 4테이블(`search_aggregates`·`company_observations`·`website_observations`·`channel_observations`)을 `run_date` 기준 월 단위 파티션으로 전환하고, 365일 초과 파티션을 detach→drop 하는 유지 함수를 붙인다 (설계서 4.2 P7 완료 기준).

**Architecture:** 파티션 키는 `runs.run_date`에서 오는 `run_date date not null` (재시도 불변 → 기존 upsert 멱등성이 DB 제약으로 유지). `search_hits`는 `(aggregate_id, run_date)` 복합 FK로 전환. 유지 함수 `maintain_observation_partitions()`는 +2개월 선생성(RLS 포함)과 만료 drop을 맡고, `cleanup_by_capacity()`와 `startRun` 두 곳에서 불린다. 스펙: `docs/superpowers/specs/2026-07-31-observation-partitioning-design.md`

**Tech Stack:** PostgreSQL 17 선언적 파티셔닝 · plpgsql · postgres.js · vitest (`pnpm test:db` = `vitest run --config vitest.pg.config.ts`)

## Global Constraints

- 마이그레이션은 파일 단위 원자 적용 (`migrate.ts` — simple query protocol). 새 파일명은 `0015_partition_observations.sql` (사전순 뒤)
- `run_date`에 **default 를 두지 않는다** — 빠뜨리면 not null 에러로 즉시 죽어야 한다 (UTC `current_date` ≠ KST `runs.run_date`)
- 파티션 이름 규칙: `<parent>_yYYYYmMM` (예: `search_aggregates_y2026m07`) — 유지 함수가 이름에서 월을 파싱한다
- 새 파티션에는 반드시 `enable row level security` — `schema.pg.test.ts` RLS 린트가 `relkind='r'` 전수 검사
- 데이터 지우는 함수는 `authenticated`에 실행권 금지, `leadops_worker`에만 (0005 원칙)
- DB 테스트는 실제 Postgres (`pnpm db:up` 컨테이너, 55432). mock 금지
- 커밋 메시지 끝: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: 마이그레이션 0015 + 파티션 스키마 테스트

**Files:**
- Create: `packages/db/migrations/0015_partition_observations.sql`
- Test: `packages/db/src/partitions.pg.test.ts`

**Interfaces:**
- Produces: 파티션 부모 4개(컬럼 동일 + `run_date date not null`), `public.maintain_observation_partitions() returns jsonb`, `cleanup_by_capacity()` 반환에 `partitions` 키 추가. `search_hits.run_date date not null` + 복합 FK.
- 이후 태스크가 의존: unique 제약이 `(..., run_date)`로 확장됨 — conflict target 수정은 Task 2.

> ⚠️ 이 태스크 완료 시점에 **기존 파이프라인 pg 테스트 일부가 빨간불이 된다** (스테이지 insert에 `run_date`가 없어 not null 위반). Task 2·3이 풀어준다. 이 태스크의 green 기준은 `partitions.pg.test.ts` + `schema.pg.test.ts` + `ops.pg.test.ts`다.

- [ ] **Step 1: 실패하는 테스트 작성** — `packages/db/src/partitions.pg.test.ts`

```typescript
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
      values (${companyId}, 'blog', 'https://blog.example.kr/pk') returning id
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
        'blog', 'https://blog.example.kr/1', 'hash-pk-1'
      )
    `;
    await db.owner`delete from search_aggregates where id = ${agg!.id} and run_date = ${runDate}::date`;
    const hits = await db.owner<{ id: string }[]>`
      select id from search_hits where url_hash = 'hash-pk-1'
    `;
    expect(hits).toHaveLength(0);
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

    const [row] = await db.owner<{ maintain_observation_partitions: { created: string[]; dropped: string[] } }[]>`
      select public.maintain_observation_partitions()
    `;
    const result = row!.maintain_observation_partitions;
    expect(result.dropped.join(",")).toContain(`company_observations_${old.name}`);

    const gone = await db.owner<{ relname: string }[]>`
      select relname from pg_class where relname = ${`company_observations_${old.name}`}
    `;
    expect(gone).toHaveLength(0);

    // 두 번째 호출: 이미 다 있으므로 아무것도 만들지도 지우지도 않는다.
    const [again] = await db.owner<{ maintain_observation_partitions: { created: string[]; dropped: string[] } }[]>`
      select public.maintain_observation_partitions()
    `;
    expect(again!.maintain_observation_partitions.created).toEqual([]);
    expect(again!.maintain_observation_partitions.dropped).toEqual([]);
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
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test:db -- partitions` (또는 `pnpm exec vitest run --config vitest.pg.config.ts packages/db/src/partitions.pg.test.ts`)
Expected: FAIL — `relkind='p'` 검사가 빈 배열 (아직 일반 테이블)

- [ ] **Step 3: 마이그레이션 작성** — `packages/db/migrations/0015_partition_observations.sql`

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- 관측 테이블 월 단위 파티셔닝 (설계서 4.2 · P7 완료 기준의 마지막 코드 항목)
--
-- 파티션 키는 `run_date` — runs.run_date 에서 온다. observed_at/collected_at 을 키로
-- 쓰면 재시도마다 값이 달라 upsert 멱등성(unique 제약)이 무력화되기 때문이다.
-- 같은 attempt 의 재시도는 항상 같은 run_date 라 conflict 가 기존과 동일하게 발화한다.
--
-- ❗ run_date 에 default 를 두지 않는다. current_date 는 UTC 라 KST 06:00 실행에서
--    runs.run_date 와 다른 날이 된다 — 코드가 빠뜨리면 조용히 다른 파티션에 들어가는
--    대신 not null 위반으로 즉시 죽는다.
--
-- detach 한 파티션은 즉시 drop 한다 (발주자 결정 2026-07-31) — 기존 row delete 동작과
-- 동등하되 즉시·저비용이고, 백업은 pg_dump 리허설 체계가 담당한다.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── (1) search_hits FK 분리 (재생성 전에 끊어야 old 테이블을 지울 수 있다) ──
alter table search_hits drop constraint search_hits_aggregate_id_fkey;
alter table search_hits add column run_date date;
update search_hits h
  set run_date = r.run_date
  from run_attempts a join runs r on r.id = a.run_id
  where a.id = h.attempt_id;
alter table search_hits alter column run_date set not null;

-- ── (2) 테이블 재생성: rename → 파티션 부모 → 파티션 → backfill → drop ──

-- 2-1. company_observations
alter table company_observations rename to company_observations_old;
create table company_observations (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  run_date date not null,
  observed_at timestamptz not null default now(),
  status company_status not null,
  content_fingerprint text,
  change_detected boolean not null default false,
  track text not null check (track in ('new', 'changed', 'unchanged', 'recontact')),
  summary jsonb not null default '{}'::jsonb,
  primary key (id, run_date),
  unique (company_id, attempt_id, run_date)
) partition by range (run_date);
create index company_observations_cleanup on company_observations (observed_at);

-- 2-2. website_observations
alter table website_observations rename to website_observations_old;
create table website_observations (
  id uuid not null default gen_random_uuid(),
  website_id uuid not null references websites(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  run_date date not null,
  observed_at timestamptz not null default now(),
  official_status official_status not null,
  official_score numeric(5, 2),
  signals jsonb not null default '{}'::jsonb,
  robots_allowed boolean,
  has_noindex boolean,
  has_contact_form_only boolean,
  http_status int,
  tech_signals jsonb not null default '{}'::jsonb,
  crawled_pages int not null default 0,
  content_hash text,
  primary key (id, run_date),
  unique (website_id, attempt_id, run_date)
) partition by range (run_date);

-- 2-3. channel_observations
alter table channel_observations rename to channel_observations_old;
create table channel_observations (
  id uuid not null default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  run_date date not null,
  is_active boolean,
  last_post_at date,
  posts_60d int,
  posts_120d int,
  cadence_days numeric(6, 2),
  content_mix jsonb not null default '{}'::jsonb,
  analyzable boolean not null default true,
  unavailable_reason text,
  observed_at timestamptz not null default now(),
  feed_saturated boolean not null default false,
  primary key (id, run_date),
  unique (channel_id, attempt_id, run_date)
) partition by range (run_date);
comment on column channel_observations.feed_saturated is
  '피드가 120일 창을 덮지 못했다. posts_60d·posts_120d 는 하한값이다.';

-- 2-4. search_aggregates (bigserial 시퀀스는 이름을 물려받는다)
alter table search_aggregates rename to search_aggregates_old;
alter sequence search_aggregates_id_seq rename to search_aggregates_old_id_seq;
create table search_aggregates (
  id bigserial,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  run_date date not null,
  keyword text not null,
  keyword_kind text not null check (keyword_kind in ('brand', 'nonbrand')),
  provider text not null,
  total_returned int not null,
  denominator int not null constraint search_aggregates_denominator_nonneg check (denominator >= 0),
  related_count int not null,
  official_count int not null,
  recency_dist jsonb not null default '{}'::jsonb,
  all_url_hashes text[] not null default '{}',
  classifier_version text not null,
  ors numeric(5, 4),
  collected_at timestamptz not null default now(),
  primary key (id, run_date),
  unique (attempt_id, company_id, keyword, provider, run_date)
) partition by range (run_date);
create index search_aggregates_cleanup on search_aggregates (collected_at);
comment on column search_aggregates.denominator is
  'min(30, total_returned). 0 이면 그 키워드로 채널에 결과가 없다는 뜻이고 ors 는 null 이다.';

-- ── (3) 파티션 생성: 기존 데이터가 걸치는 달 ~ 현재+2개월 ──
do $part$
declare
  v_parent text;
  v_from date;
  v_to date := (date_trunc('month', now()) + interval '2 months')::date;
  v_month date;
  v_name text;
begin
  -- runs.run_date 최솟값이 관측 데이터의 하한이다 (관측은 전부 attempt → run 을 거친다)
  select coalesce(date_trunc('month', min(run_date))::date, date_trunc('month', now())::date)
    into v_from from runs;
  foreach v_parent in array array[
    'search_aggregates', 'company_observations', 'website_observations', 'channel_observations'
  ] loop
    v_month := v_from;
    while v_month <= v_to loop
      v_name := format('%s_y%sm%s', v_parent, to_char(v_month, 'YYYY'), to_char(v_month, 'MM'));
      execute format(
        'create table %I partition of %I for values from (%L) to (%L)',
        v_name, v_parent, v_month, (v_month + interval '1 month')::date
      );
      execute format('alter table %I enable row level security', v_name);
      v_month := (v_month + interval '1 month')::date;
    end loop;
  end loop;
end
$part$;

-- ── (4) backfill (id 보존 — search_hits.aggregate_id 가 살아 있어야 한다) ──
insert into company_observations (
  id, company_id, attempt_id, run_date, observed_at, status,
  content_fingerprint, change_detected, track, summary
)
select o.id, o.company_id, o.attempt_id, r.run_date, o.observed_at, o.status,
       o.content_fingerprint, o.change_detected, o.track, o.summary
from company_observations_old o
join run_attempts a on a.id = o.attempt_id
join runs r on r.id = a.run_id;

insert into website_observations (
  id, website_id, attempt_id, run_date, observed_at, official_status, official_score,
  signals, robots_allowed, has_noindex, has_contact_form_only, http_status,
  tech_signals, crawled_pages, content_hash
)
select o.id, o.website_id, o.attempt_id, r.run_date, o.observed_at, o.official_status,
       o.official_score, o.signals, o.robots_allowed, o.has_noindex,
       o.has_contact_form_only, o.http_status, o.tech_signals, o.crawled_pages, o.content_hash
from website_observations_old o
join run_attempts a on a.id = o.attempt_id
join runs r on r.id = a.run_id;

insert into channel_observations (
  id, channel_id, attempt_id, run_date, is_active, last_post_at, posts_60d, posts_120d,
  cadence_days, content_mix, analyzable, unavailable_reason, observed_at, feed_saturated
)
select o.id, o.channel_id, o.attempt_id, r.run_date, o.is_active, o.last_post_at,
       o.posts_60d, o.posts_120d, o.cadence_days, o.content_mix, o.analyzable,
       o.unavailable_reason, o.observed_at, o.feed_saturated
from channel_observations_old o
join run_attempts a on a.id = o.attempt_id
join runs r on r.id = a.run_id;

insert into search_aggregates (
  id, attempt_id, company_id, run_date, keyword, keyword_kind, provider,
  total_returned, denominator, related_count, official_count,
  recency_dist, all_url_hashes, classifier_version, ors, collected_at
)
select o.id, o.attempt_id, o.company_id, r.run_date, o.keyword, o.keyword_kind, o.provider,
       o.total_returned, o.denominator, o.related_count, o.official_count,
       o.recency_dist, o.all_url_hashes, o.classifier_version, o.ors, o.collected_at
from search_aggregates_old o
join run_attempts a on a.id = o.attempt_id
join runs r on r.id = a.run_id;
select setval('search_aggregates_id_seq',
              coalesce((select max(id) from search_aggregates), 0) + 1, false);

drop table company_observations_old;
drop table website_observations_old;
drop table channel_observations_old;
drop table search_aggregates_old;

-- ── (5) search_hits 복합 FK 재연결 ──
alter table search_hits
  add constraint search_hits_aggregate_fkey
  foreign key (aggregate_id, run_date) references search_aggregates (id, run_date)
  on delete cascade;

-- ── (6) RLS · 정책 · GRANT (0003 · 0005 와 같은 형태 — 부모에 걸면 파티션 접근에 적용) ──
do $sec$
declare t text;
begin
  foreach t in array array[
    'search_aggregates', 'company_observations', 'website_observations', 'channel_observations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format(
      'create policy %I on public.%I for all to leadops_worker using (true) with check (true)',
      t || '_worker', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to leadops_worker', t);
  end loop;
end
$sec$;
grant usage, select on sequence search_aggregates_id_seq to leadops_worker;

-- ── (7) 파티션 유지 함수 ──
--
-- pg_partman 을 쓰지 않는 이유: 로컬 컨테이너에 없어 검증할 수 없다 (pg_cron 을
-- deploy/ 로 분리한 것과 같은 원칙). 파티션 이름(_yYYYYmMM)에서 월을 파싱한다.
create or replace function public.maintain_observation_partitions()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_parents constant text[] := array[
    'search_aggregates', 'company_observations', 'website_observations', 'channel_observations'
  ];
  v_parent text;
  v_month date;
  v_name text;
  v_created text[] := '{}';
  v_dropped text[] := '{}';
  v_child record;
  v_m text[];
  v_upper date;
begin
  foreach v_parent in array v_parents loop
    -- 선생성: 이번 달 ~ +2개월. 실행 직전(startRun)에도 불리므로 파티션 부재로
    -- insert 가 죽는 일이 없다 (default 파티션을 두지 않는 대신의 안전망).
    for i in 0..2 loop
      v_month := (date_trunc('month', now()) + make_interval(months => i))::date;
      v_name := format('%s_y%sm%s', v_parent, to_char(v_month, 'YYYY'), to_char(v_month, 'MM'));
      if not exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relname = v_name and n.nspname = 'public'
      ) then
        execute format(
          'create table %I partition of %I for values from (%L) to (%L)',
          v_name, v_parent, v_month, (v_month + interval '1 month')::date
        );
        execute format('alter table %I enable row level security', v_name);
        v_created := v_created || v_name;
      end if;
    end loop;

    -- 만료: 파티션 상한(다음 달 1일)이 365일 전보다 오래됐으면 detach → 즉시 drop.
    -- 이름에서 월을 파싱한다 — 우리가 만든 파티션만 이 규칙을 따르므로 안전하다.
    for v_child in
      select c.relname
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
      where p.relname = v_parent
    loop
      v_m := regexp_match(v_child.relname, '_y(\d{4})m(\d{2})$');
      if v_m is null then
        continue;  -- 규칙 밖 이름은 건드리지 않는다
      end if;
      v_upper := (make_date(v_m[1]::int, v_m[2]::int, 1) + interval '1 month')::date;
      if v_upper <= (now() - interval '365 days')::date then
        execute format('alter table %I detach partition %I', v_parent, v_child.relname);
        execute format('drop table %I', v_child.relname);
        v_dropped := v_dropped || v_child.relname;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('created', v_created, 'dropped', v_dropped);
end;
$$;
revoke execute on function public.maintain_observation_partitions() from public;
grant execute on function public.maintain_observation_partitions() to leadops_worker;

-- ── (8) cleanup_by_capacity 에 파티션 유지를 편입 (0012 본문 + maintain 호출) ──
create or replace function public.cleanup_by_capacity()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_cap jsonb;
  v_base jsonb;
  v_parts jsonb;
  v_aggressive jsonb := '{}'::jsonb;
  v_hits int := 0; v_aggs int := 0; v_obs int := 0;
begin
  v_cap := public.db_capacity();
  v_base := public.cleanup_old_data();
  v_parts := public.maintain_observation_partitions();

  if (v_cap ->> 'level') in ('cleanup', 'block') then
    -- 관련 문서 30일 → 7일, 집계·관측 365일 → 120일.
    -- ❗ row delete 는 파티션 경계와 무관하게 동작해야 하므로 유지한다.
    --    365일 경계는 파티션 drop 이 맡는다 (월 단위 — 최대 1개월 지연 수용).
    delete from search_hits where collected_at < now() - interval '7 days';
    get diagnostics v_hits = row_count;
    delete from search_aggregates where collected_at < now() - interval '120 days';
    get diagnostics v_aggs = row_count;
    delete from company_observations where observed_at < now() - interval '120 days';
    get diagnostics v_obs = row_count;

    v_aggressive := jsonb_build_object(
      'search_hits', v_hits, 'search_aggregates', v_aggs, 'company_observations', v_obs
    );
  end if;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (null, 'ops.cleanup', 'settings', null,
          jsonb_build_object('before', v_cap, 'base', v_base, 'partitions', v_parts,
                             'aggressive', v_aggressive, 'after', public.db_capacity()));

  return jsonb_build_object(
    'capacity_before', v_cap,
    'base', v_base,
    'partitions', v_parts,
    'aggressive', v_aggressive,
    'capacity_after', public.db_capacity()
  );
end;
$$;
revoke execute on function public.cleanup_by_capacity() from public;
grant execute on function public.cleanup_by_capacity() to leadops_worker;
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm test:db -- partitions` → PASS 전부
Run: `pnpm exec vitest run --config vitest.pg.config.ts packages/db/src/schema.pg.test.ts packages/db/src/ops.pg.test.ts` → PASS (RLS 린트가 파티션 자식까지 통과, cleanup 반환 형태 회귀 없음 확인)

- [ ] **Step 5: 커밋**

```bash
git add packages/db/migrations/0015_partition_observations.sql packages/db/src/partitions.pg.test.ts
git commit -m "관측 4테이블 월 단위 파티셔닝 — run_date 키 · 365일 detach·drop"
```

---

### Task 2: 파이프라인 — StageContext.runDate + 스테이지 insert 4곳

**Files:**
- Modify: `packages/pipeline/src/stages/types.ts:14-27` (StageContext)
- Modify: `apps/worker/src/loop.ts:165-182` (ctx 구성)
- Modify: `packages/pipeline/src/stages/normalize.ts:133-148`
- Modify: `packages/pipeline/src/stages/search.ts:217-262`
- Modify: `packages/pipeline/src/stages/homepage.ts:242-266`
- Modify: `packages/pipeline/src/stages/channel.ts:167-191`
- Modify: `packages/pipeline/src/orchestrator.ts:50-99` (startRun 에 maintain 호출)

**Interfaces:**
- Consumes: Task 1 의 스키마 (unique 에 `run_date` 포함, `maintain_observation_partitions()`)
- Produces: `StageContext.runDate: string` (YYYY-MM-DD) — 모든 스테이지 pg 테스트의 ctx 구성이 이 필드를 요구하게 된다 (Task 3 이 사용)

- [ ] **Step 1: StageContext 에 runDate 추가** — `types.ts` interface 에:

```typescript
  /** 이 실행의 runs.run_date (YYYY-MM-DD). 관측 테이블의 파티션 키다 — 재시도에 불변. */
  runDate: string;
```

- [ ] **Step 2: 워커 ctx 구성 수정** — `loop.ts` 165행 select 와 172행 ctx:

```typescript
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
      ...
```

- [ ] **Step 3: normalize.ts 관측 insert 수정** (133-148행):

```typescript
          await tx`
            insert into company_observations (
              company_id, attempt_id, run_date, status, content_fingerprint, change_detected, track, summary
            )
            values (
              ${company!.id}, ${ctx.attemptId}, ${ctx.runDate}::date, ${c.status}, ${fingerprint},
              ${changed}, ${track},
              ${tx.json({ source: c.source, externalId: c.externalId, dedupeBasis: dedupe.basis, dedupeConfidence: dedupe.confidence })}
            )
            on conflict (company_id, attempt_id, run_date) do update set
              status = excluded.status,
              content_fingerprint = excluded.content_fingerprint,
              change_detected = excluded.change_detected,
              track = excluded.track,
              summary = excluded.summary
          `;
```

- [ ] **Step 4: search.ts persistAggregates 수정** — aggregates insert (219-241행):

```typescript
      const [row] = await tx<Array<{ id: string }>>`
        insert into search_aggregates (
          attempt_id, company_id, run_date, keyword, keyword_kind, provider,
          total_returned, denominator, related_count, official_count,
          recency_dist, all_url_hashes, classifier_version, ors
        ) values (
          ${ctx.attemptId}, ${companyId}, ${ctx.runDate}::date, ${keyword}, ${keywordKind}, ${aggregate.provider},
          ${aggregate.totalReturned}, ${aggregate.denominator}, ${aggregate.relatedCount},
          ${aggregate.officialCount}, ${tx.json(aggregate.recencyDist)},
          ${aggregate.hits.map((h) => h.urlHash)}, ${CLASSIFIER_VERSION}, ${aggregate.ors}
        )
        on conflict (attempt_id, company_id, keyword, provider, run_date) do update set
          total_returned = excluded.total_returned,
          denominator = excluded.denominator,
          related_count = excluded.related_count,
          official_count = excluded.official_count,
          recency_dist = excluded.recency_dist,
          all_url_hashes = excluded.all_url_hashes,
          classifier_version = excluded.classifier_version,
          ors = excluded.ors,
          collected_at = now()
        returning id
      `;
```

hits insert (247-258행) — `run_date` 추가 (conflict target 은 그대로 — search_hits 는 파티션이 아니다):

```typescript
        await tx`
          insert into search_hits (
            aggregate_id, run_date, attempt_id, company_id, keyword, rank, channel_type,
            is_official, url, url_hash, title, published_at, recency
          ) values (
            ${aggregateId}, ${ctx.runDate}::date, ${ctx.attemptId}, ${companyId}, ${keyword}, ${hit.rank},
            ${hit.channelType}::channel_type, ${hit.isOfficial}, ${hit.url}, ${hit.urlHash},
            ${hit.title}, ${hit.publishedAt ? hit.publishedAt.toISOString().slice(0, 10) : null}::date,
            ${hit.recency}::recency_bucket
          )
          on conflict (attempt_id, company_id, keyword, url_hash) do nothing
        `;
```

- [ ] **Step 5: homepage.ts persist 수정** (243-266행) — 컬럼에 `run_date`, values 에 `${ctx.runDate}::date`, conflict 를 `(website_id, attempt_id, run_date)` 로:

```typescript
    await tx`
      insert into website_observations (
        website_id, attempt_id, run_date, official_status, official_score, signals,
        robots_allowed, has_noindex, has_contact_form_only, http_status,
        tech_signals, crawled_pages, content_hash
      ) values (
        ${target.website_id}, ${ctx.attemptId}, ${ctx.runDate}::date, ${verdict.status}::official_status, ${verdict.score},
        ${tx.json(verdict.signals)}, ${outcome.robotsAllowed}, ${outcome.hasNoindex},
        ${verdict.hasContactFormOnly}, ${outcome.httpStatus},
        ${tx.json({ domainClass: verdict.domainClass })}, ${outcome.crawledPages}, ${outcome.contentHash}
      )
      on conflict (website_id, attempt_id, run_date) do update set
        official_status = excluded.official_status,
        official_score = excluded.official_score,
        signals = excluded.signals,
        robots_allowed = excluded.robots_allowed,
        has_noindex = excluded.has_noindex,
        has_contact_form_only = excluded.has_contact_form_only,
        http_status = excluded.http_status,
        tech_signals = excluded.tech_signals,
        crawled_pages = excluded.crawled_pages,
        content_hash = excluded.content_hash,
        observed_at = now()
    `;
```

- [ ] **Step 6: channel.ts persist 수정** (168-190행) — 같은 패턴:

```typescript
  await ctx.sql`
    insert into channel_observations (
      channel_id, attempt_id, run_date, is_active, last_post_at, posts_60d, posts_120d,
      cadence_days, content_mix, analyzable, unavailable_reason, feed_saturated
    ) values (
      ${target.channel_id}, ${ctx.attemptId}, ${ctx.runDate}::date, ${isActive(metrics)},
      ${metrics.lastPostAt ?? null}::date, ${metrics.analyzable ? metrics.posts60d : null},
      ${metrics.analyzable ? metrics.posts120d : null}, ${metrics.cadenceDays ?? null},
      ${ctx.sql.json(metrics.contentMix)}, ${metrics.analyzable},
      ${metrics.unavailableReason ?? null}, ${metrics.saturated}
    )
    on conflict (channel_id, attempt_id, run_date) do update set
      is_active = excluded.is_active,
      last_post_at = excluded.last_post_at,
      posts_60d = excluded.posts_60d,
      posts_120d = excluded.posts_120d,
      cadence_days = excluded.cadence_days,
      content_mix = excluded.content_mix,
      analyzable = excluded.analyzable,
      unavailable_reason = excluded.unavailable_reason,
      feed_saturated = excluded.feed_saturated,
      observed_at = now()
  `;
```

- [ ] **Step 7: startRun 에 파티션 선생성** — `orchestrator.ts` 54행 (industries 검증 직후, 용량 게이트 앞):

```typescript
  // ❗ 파티션을 실행 전에 보장한다. run_date 파티션이 없으면 관측 insert 가 그 자리에서
  //    죽는다 (default 파티션을 두지 않았다 — 조용한 오라우팅 방지). 이 호출이 안전망이다.
  await sql`select public.maintain_observation_partitions()`;
```

- [ ] **Step 8: typecheck 로 남은 ctx 구성 지점 확인**

Run: `pnpm typecheck`
Expected: FAIL — 스테이지 pg 테스트들의 `StageContext` 구성에 `runDate` 누락. **파일 목록을 기록해 두고 (Task 3 입력) 이 시점에는 고치지 않는다.** 프로덕션 코드(`apps/`·`packages/*/src`, 테스트 제외)에서 에러가 나면 여기서 고친다.

- [ ] **Step 9: 커밋**

```bash
git add packages/pipeline/src/stages/types.ts apps/worker/src/loop.ts \
  packages/pipeline/src/stages/normalize.ts packages/pipeline/src/stages/search.ts \
  packages/pipeline/src/stages/homepage.ts packages/pipeline/src/stages/channel.ts \
  packages/pipeline/src/orchestrator.ts
git commit -m "스테이지 관측 insert 에 run_date — StageContext.runDate · startRun 파티션 선생성"
```

---

### Task 3: fixture·테스트 정합 + 전체 verify

**Files:**
- Modify: `packages/db/src/fixtures.ts:21-36` (createRun — runDate 동적 기본값·반환)
- Modify: `packages/pipeline/src/stages/homepage.pg.test.ts:145` 부근
- Modify: `packages/pipeline/src/stages/homepageDiscover.pg.test.ts:56` 부근
- Modify: `packages/pipeline/src/stages/phase4.pg.test.ts:139,244,252` 부근
- Modify: `packages/pipeline/src/stages/phase5.pg.test.ts:80,91,111` 부근
- Modify: Task 2 Step 8 에서 typecheck 가 찾아준 나머지 ctx 구성 지점 전부

**Interfaces:**
- Consumes: Task 1 스키마, Task 2 의 `StageContext.runDate`
- Produces: `createRun(db, runDate?, trigger?)` 가 `{ runId, attemptId, runDate }` 를 반환. 기본 runDate 는 **오늘(UTC)** — 고정 `"2026-07-29"` 는 시간이 지나면 파티션 밖으로 밀려나므로 폐기.

- [ ] **Step 1: fixtures.ts createRun 수정**

```typescript
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
```

기존 주석(`runs_one_cron_per_day` 설명)은 그대로 둔다.

- [ ] **Step 2: 관측 insert 가 있는 pg 테스트 4파일 수정**

각 파일에서 `createRun` 반환의 `runDate` 를 받아 (구조분해에 추가), 관측 insert 에 `run_date` 컬럼과 `${runDate}::date` 값을 추가한다. 예 — `homepage.pg.test.ts:145`:

```typescript
    insert into company_observations (company_id, attempt_id, run_date, status, track)
    values (${companyId}, ${attemptId}, ${runDate}::date, 'active', 'new')
```

같은 패턴으로: `homepageDiscover.pg.test.ts:56` (컬럼 목록에 `run_date` 추가),
`phase4.pg.test.ts:139·244` (company_observations) · `:252` (website_observations),
`phase5.pg.test.ts:80` (company_observations) · `:91` (website_observations) · `:111` (channel_observations).

테스트가 자체 SQL 로 runs/run_attempts 를 만드는 경우 그 run 의 `run_date` 값을 그대로 쓴다 — **관측의 `run_date` 는 반드시 그 attempt 가 속한 run 의 `run_date` 와 같아야 한다** (프로덕션 경로가 그렇게 동작한다).

- [ ] **Step 3: ctx 구성 지점에 runDate 추가**

Task 2 Step 8 이 기록한 파일 전부: `StageContext` 리터럴에 `runDate` 를 추가한다. 값은 그 테스트가 쓰는 run 의 날짜 (fixture 면 `runDate` 반환값, 자체 SQL 이면 그 값).

- [ ] **Step 4: 전체 verify**

Run: `pnpm typecheck` → PASS
Run: `pnpm test` → PASS (단위 — DB 무관이므로 영향 없어야 정상)
Run: `pnpm test:db` → PASS 전체 (기존 287 + 신규 파티션 테스트)

- [ ] **Step 5: 커밋**

```bash
git add packages/db/src/fixtures.ts packages/pipeline/src/stages/*.pg.test.ts
git commit -m "테스트 fixture 에 run_date — createRun 동적 날짜·반환값 확장"
```

---

### Task 4: 워커 스모크 + 문서 갱신

**Files:**
- Modify: `README.md` (DB 계층 표 · "아직 없는 것" 절)
- Modify: `docs/07-runbook.md` (용량 절에 파티션 유지 한 줄)

**Interfaces:**
- Consumes: Task 1~3 전부 완료 상태

- [ ] **Step 1: 마이그레이션을 로컬 개발 DB 에 적용하고 mock 실행 스모크**

```powershell
$env:DATABASE_URL='postgres://postgres:leadops@127.0.0.1:55432/leadops'; pnpm db:migrate
$env:WORKER_DATABASE_URL='postgres://leadops_worker:leadops-worker-dev@127.0.0.1:55432/leadops'; `
  $env:FEATURE_SOURCE='mock'; pnpm worker run --industry=derm --limit 5
```

Expected: 실행이 끝까지 돌고 (`상태: succeeded` 또는 `partial`), 아래 질의에서 이번 달 파티션에 관측 행이 존재:

```powershell
docker exec leadops-pg psql -U postgres -d leadops -c "select tableoid::regclass, count(*) from company_observations group by 1"
```

- [ ] **Step 2: README 갱신**

- DB 계층 표에 행 추가: `| \`0015_partition_observations\` | 관측 4테이블 월 파티션 · \`run_date\` 키 · 365일 detach→drop |`
- "아직 없는 것" 절의 `관측 테이블 **파티셔닝**` 을 목록에서 제거 (Supabase Auth · Outreach 만 남는다)

- [ ] **Step 3: 런북 갱신**

`docs/07-runbook.md` 용량 관련 절에 추가:

```markdown
파티션 유지는 `maintain_observation_partitions()` 가 한다 — `cleanup_by_capacity()`(워커
cleanup·pg_cron)와 `startRun` 양쪽에서 불린다. +2개월 선생성, 365일 초과 파티션은
detach 후 즉시 drop (백업은 pg_dump 리허설 체계가 담당).
```

- [ ] **Step 4: 최종 verify + 커밋**

Run: `pnpm verify` → PASS 전부

```bash
git add README.md docs/07-runbook.md
git commit -m "파티셔닝 문서 반영 — README DB 계층 표 · 런북 용량 절"
```

---

## Self-Review 결과

- **스펙 커버리지**: 4테이블 재생성(Task 1) · 복합 FK(Task 1) · 유지 함수+호출 2지점(Task 1·2) · default 부재(Task 1 테스트) · 스테이지 4곳+ctx(Task 2) · 테스트 6항목(Task 1 — upsert 4종·라우팅·default 부재·drop·cascade·권한) · 기존 테스트 수정(Task 3) · 스모크·문서(Task 4). 스펙의 "insert 라우팅" 검증은 Task 4 Step 1 의 `tableoid::regclass` 질의가 실데이터로 확인한다.
- **플레이스홀더**: 없음 — 모든 SQL·TS 코드 전문 수록.
- **타입 일관성**: `runDate: string` (YYYY-MM-DD) 로 통일 — StageContext(Task 2)·createRun 반환(Task 3) 동일. 함수명 `maintain_observation_partitions` 전 태스크 동일.
