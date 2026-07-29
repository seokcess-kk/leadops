-- ─────────────────────────────────────────────────────────────────────────────
-- RLS (설계서 6.3 · F-12 · R2-20)
--
-- v2 의 치명적 결함: `review_decide` UPDATE 정책의 `WITH CHECK (true)` 는 인증된
-- 일반 사용자가 PostgREST 로 `PATCH /review_items?id=eq.X` 를 호출해 status·score_id·
-- rank 등 **모든 컬럼을 임의로 변경**하고 승인 상한을 우회하게 만들었다.
-- "UI 는 RPC 만 호출한다" 는 약속은 통제 수단이 아니다.
--
-- v3 원칙:
--   1. 모든 public 테이블에 RLS 를 켠다.
--   2. `authenticated` 에게는 **SELECT 정책만** 준다. INSERT/UPDATE/DELETE 정책은 0개.
--   3. 모든 쓰기는 SECURITY DEFINER RPC 를 통한다.
--   4. 워커는 전용 역할(`leadops_worker`)로 명시적 정책을 받는다. service_role 키를
--      DB 접속에 쓰지 않는다 (F-14 — 그 키는 PostgREST 용 JWT 이지 DB 비밀번호가 아니다).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 헬퍼 ─────────────────────────────────────────────────────────────────────
create or replace function public.is_admin() returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ── 전 테이블 RLS 활성화 ─────────────────────────────────────────────────────
do $rls$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
end
$rls$;

-- ── 읽기 정책: authenticated 는 전부 읽을 수 있다 ────────────────────────────
do $read$
declare t text;
begin
  foreach t in array array[
    'profiles', 'source_registry', 'runs', 'run_attempts', 'run_stages',
    'company_groups', 'companies', 'company_observations',
    'websites', 'website_observations', 'contact_pages',
    'emails', 'email_occurrences', 'company_keywords',
    'search_aggregates', 'search_hits', 'channels', 'channel_observations',
    'competitors', 'competitor_metrics',
    'scores', 'score_inputs', 'recommendations',
    'review_items', 'leads', 'privacy_requests', 'settings'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_read', t);
  end loop;
end
$read$;

-- profiles 는 본인 또는 admin 만 (위 일괄 정책을 덮어쓴다)
drop policy profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- ── 민감 테이블: admin 만 읽기 ───────────────────────────────────────────────
create policy audit_log_read on public.audit_log for select to authenticated
  using (public.is_admin());
create policy cost_ledger_read on public.cost_ledger for select to authenticated
  using (public.is_admin());
create policy jobs_read on public.jobs for select to authenticated
  using (public.is_admin());

-- ❗ approval_day_totals · approval_counters · review_view_nonces · http_cache ·
--    outbox 에는 authenticated 정책을 **하나도 만들지 않는다**.
--    RPC 내부(security definer)에서만 접근한다.

-- ── 워커 정책 ────────────────────────────────────────────────────────────────
-- 워커는 파이프라인 테이블에 쓴다. leads 는 제외한다 — 리드는 승인 RPC 만 만든다.
do $worker$
declare t text;
begin
  foreach t in array array[
    'runs', 'run_attempts', 'run_stages',
    'company_groups', 'companies', 'company_observations',
    'websites', 'website_observations', 'contact_pages',
    'emails', 'email_occurrences', 'company_keywords',
    'search_aggregates', 'search_hits', 'channels', 'channel_observations',
    'competitors', 'competitor_metrics',
    'scores', 'score_inputs', 'recommendations', 'review_items',
    'cost_ledger', 'http_cache', 'outbox', 'audit_log'
  ]
  loop
    execute format(
      'create policy %I on public.%I for all to leadops_worker using (true) with check (true)',
      t || '_worker', t);
  end loop;
end
$worker$;

-- ❗ jobs 는 워커에게 읽기·enqueue 만 허용한다.
--    상태 전이(획득·heartbeat·완료)는 acquire_job / heartbeat_job / complete_job RPC 로만 한다.
--    UPDATE 를 열어 두면 fencing 을 우회해 좀비 워커가 결과를 덮어쓸 수 있다.
create policy jobs_worker_read on public.jobs for select to leadops_worker using (true);
create policy jobs_worker_enqueue on public.jobs for insert to leadops_worker with check (true);

-- 워커는 설정·레지스트리를 읽기만 한다.
create policy settings_worker_read on public.settings for select to leadops_worker using (true);
create policy source_registry_worker_read on public.source_registry for select to leadops_worker using (true);
create policy profiles_worker_read on public.profiles for select to leadops_worker using (true);
create policy leads_worker_read on public.leads for select to leadops_worker using (true);

-- ── 신규 사용자 → profiles 자동 생성 ─────────────────────────────────────────
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, coalesce(new.email, ''), 'user')
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
