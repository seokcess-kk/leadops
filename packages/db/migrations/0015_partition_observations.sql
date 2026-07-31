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
alter table company_observations_old drop constraint if exists company_observations_pkey cascade;
alter table company_observations_old drop constraint if exists company_observations_company_id_fkey cascade;
alter table company_observations_old drop constraint if exists company_observations_attempt_id_fkey cascade;
alter table company_observations_old drop constraint if exists company_observations_track_check cascade;
alter table company_observations_old drop constraint if exists company_observations_company_id_attempt_id_run_date_key cascade;
drop index if exists company_observations_cleanup;
create table company_observations (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  attempt_id uuid not null,
  run_date date not null,
  observed_at timestamptz not null default now(),
  status company_status not null,
  content_fingerprint text,
  change_detected boolean not null default false,
  track text not null,
  summary jsonb not null default '{}'::jsonb,
  constraint company_observations_pkey primary key (id, run_date),
  constraint company_observations_company_id_fkey foreign key (company_id) references companies(id) on delete cascade,
  constraint company_observations_attempt_id_fkey foreign key (attempt_id) references run_attempts(id) on delete cascade,
  constraint company_observations_track_check check (track in ('new', 'changed', 'unchanged', 'recontact')),
  constraint company_observations_company_id_attempt_id_run_date_key unique (company_id, attempt_id, run_date)
) partition by range (run_date);
create index company_observations_cleanup on company_observations (observed_at);

-- 2-2. website_observations
alter table website_observations rename to website_observations_old;
alter table website_observations_old drop constraint if exists website_observations_pkey cascade;
alter table website_observations_old drop constraint if exists website_observations_website_id_fkey cascade;
alter table website_observations_old drop constraint if exists website_observations_attempt_id_fkey cascade;
alter table website_observations_old drop constraint if exists website_observations_website_id_attempt_id_run_date_key cascade;
create table website_observations (
  id uuid not null default gen_random_uuid(),
  website_id uuid not null,
  attempt_id uuid not null,
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
  constraint website_observations_pkey primary key (id, run_date),
  constraint website_observations_website_id_fkey foreign key (website_id) references websites(id) on delete cascade,
  constraint website_observations_attempt_id_fkey foreign key (attempt_id) references run_attempts(id) on delete cascade,
  constraint website_observations_website_id_attempt_id_run_date_key unique (website_id, attempt_id, run_date)
) partition by range (run_date);

-- 2-3. channel_observations
alter table channel_observations rename to channel_observations_old;
alter table channel_observations_old drop constraint if exists channel_observations_pkey cascade;
alter table channel_observations_old drop constraint if exists channel_observations_channel_id_fkey cascade;
alter table channel_observations_old drop constraint if exists channel_observations_attempt_id_fkey cascade;
alter table channel_observations_old drop constraint if exists channel_observations_channel_id_attempt_id_run_date_key cascade;
create table channel_observations (
  id uuid not null default gen_random_uuid(),
  channel_id uuid not null,
  attempt_id uuid not null,
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
  constraint channel_observations_pkey primary key (id, run_date),
  constraint channel_observations_channel_id_fkey foreign key (channel_id) references channels(id) on delete cascade,
  constraint channel_observations_attempt_id_fkey foreign key (attempt_id) references run_attempts(id) on delete cascade,
  constraint channel_observations_channel_id_attempt_id_run_date_key unique (channel_id, attempt_id, run_date)
) partition by range (run_date);
comment on column channel_observations.feed_saturated is
  '피드가 120일 창을 덮지 못했다. posts_60d·posts_120d 는 하한값이다.';

-- 2-4. search_aggregates (bigserial 시퀀스는 이름을 물려받는다)
alter table search_aggregates rename to search_aggregates_old;
alter table search_aggregates_old drop constraint if exists search_aggregates_pkey cascade;
alter table search_aggregates_old drop constraint if exists search_aggregates_attempt_id_fkey cascade;
alter table search_aggregates_old drop constraint if exists search_aggregates_company_id_fkey cascade;
alter table search_aggregates_old drop constraint if exists search_aggregates_keyword_kind_check cascade;
alter table search_aggregates_old drop constraint if exists search_aggregates_denominator_nonneg cascade;
alter table search_aggregates_old drop constraint if exists search_aggregates_attempt_id_company_id_keyword_provider_run_date_key cascade;
alter sequence search_aggregates_id_seq rename to search_aggregates_old_id_seq;
drop index if exists search_aggregates_cleanup;
create table search_aggregates (
  id bigserial,
  attempt_id uuid not null,
  company_id uuid not null,
  run_date date not null,
  keyword text not null,
  keyword_kind text not null,
  provider text not null,
  total_returned int not null,
  denominator int not null,
  related_count int not null,
  official_count int not null,
  recency_dist jsonb not null default '{}'::jsonb,
  all_url_hashes text[] not null default '{}',
  classifier_version text not null,
  ors numeric(5, 4),
  collected_at timestamptz not null default now(),
  constraint search_aggregates_pkey primary key (id, run_date),
  constraint search_aggregates_attempt_id_fkey foreign key (attempt_id) references run_attempts(id) on delete cascade,
  constraint search_aggregates_company_id_fkey foreign key (company_id) references companies(id) on delete cascade,
  constraint search_aggregates_keyword_kind_check check (keyword_kind in ('brand', 'nonbrand')),
  constraint search_aggregates_denominator_nonneg check (denominator >= 0),
  constraint search_aggregates_attempt_id_company_id_keyword_provider_run_date_key unique (attempt_id, company_id, keyword, provider, run_date)
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
  v_errors text[] := '{}';
  v_child record;
  v_m text[];
  v_upper date;
  v_rows bigint;
begin
  foreach v_parent in array v_parents loop
    -- 선생성: 이번 달 ~ +2개월. 실행 직전(startRun)에도 불리므로 파티션 부재로
    -- insert 가 죽는 일이 없다 (default 파티션을 두지 않는 대신의 안전망).
    -- 존재 확인 후 create 사이에 경쟁이 있을 수 있다 (월 경계 직후 pg_cron 과 수동 실행이
    -- 겹치는 경우) — duplicate_table 을 흡수해 다른 세션이 먼저 만든 것을 받아들인다.
    for i in 0..2 loop
      v_month := (date_trunc('month', now()) + make_interval(months => i))::date;
      v_name := format('%s_y%sm%s', v_parent, to_char(v_month, 'YYYY'), to_char(v_month, 'MM'));
      if not exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relname = v_name and n.nspname = 'public'
      ) then
        begin
          execute format(
            'create table %I partition of %I for values from (%L) to (%L)',
            v_name, v_parent, v_month, (v_month + interval '1 month')::date
          );
          execute format('alter table %I enable row level security', v_name);
          v_created := v_created || v_name;
        exception when duplicate_table then
          null;  -- 동시 호출이 먼저 만들었다 — 이번 호출은 아무것도 하지 않은 것으로 취급
        end;
      end if;
    end loop;

    -- 만료: 파티션 상한(다음 달 1일)이 365일 전보다 오래됐으면 detach → 즉시 drop.
    -- 이름에서 월을 파싱한다 — 우리가 만든 파티션만 이 규칙을 따르므로 안전하다.
    -- 선생성 쪽과 동일하게 스키마를 public 으로 좁혀 이름이 겹치는 다른 스키마 객체를 건드리지 않는다.
    for v_child in
      select c.relname
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
      join pg_namespace n on n.oid = p.relnamespace
      where p.relname = v_parent and n.nspname = 'public'
    loop
      v_m := regexp_match(v_child.relname, '_y(\d{4})m(\d{2})$');
      if v_m is null then
        continue;  -- 규칙 밖 이름은 건드리지 않는다
      end if;
      v_upper := (make_date(v_m[1]::int, v_m[2]::int, 1) + interval '1 month')::date;
      if v_upper <= (now() - interval '365 days')::date then
        -- 파티션별로 격리한다 — 하나가 실패해도(잠금 경합 등) 나머지와 startRun 전체를
        -- 롤백시키지 않는다. 실패는 errors 에 남기고 다음 파티션을 계속 처리한다.
        begin
          execute format('select count(*) from %I', v_child.relname) into v_rows;
          execute format('alter table %I detach partition %I', v_parent, v_child.relname);
          execute format('drop table %I', v_child.relname);
          v_dropped := v_dropped || format('%s(%s rows)', v_child.relname, v_rows);
        exception when others then
          v_errors := v_errors || format('%s: %s', v_child.relname, sqlerrm);
        end;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('created', v_created, 'dropped', v_dropped, 'errors', v_errors);
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
