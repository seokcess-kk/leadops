-- ─────────────────────────────────────────────────────────────────────────────
-- 권한 (설계서 6.3 · F-13 · F-14)
--
-- 원칙:
--   - authenticated 는 SELECT 만 받는다. INSERT/UPDATE/DELETE 는 아예 GRANT 하지 않는다.
--     (RLS 정책이 없어도 GRANT 가 있으면 정책 실수 한 번에 뚫린다 — 두 겹으로 막는다)
--   - 모든 함수는 PUBLIC 실행권을 회수한 뒤 필요한 역할에만 부여한다.
--   - 워커는 전용 역할로 최소 권한만 받는다.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on schema public from public;
grant usage on schema public to anon, authenticated, service_role, leadops_worker;

-- 기본값: 아무 권한도 주지 않는다.
revoke all on all tables in schema public from anon, authenticated, leadops_worker;
revoke all on all sequences in schema public from anon, authenticated, leadops_worker;
revoke all on all functions in schema public from public, anon, authenticated, leadops_worker;

-- ── authenticated: 읽기만 ────────────────────────────────────────────────────
do $g$
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
    'review_items', 'leads', 'privacy_requests', 'settings',
    'audit_log', 'cost_ledger', 'jobs'
  ]
  loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end
$g$;

-- ❗ approval_day_totals · approval_counters · review_view_nonces · http_cache · outbox
--    에는 authenticated 에게 SELECT 조차 주지 않는다. RPC 내부에서만 접근한다.

-- ── 워커: 파이프라인 테이블 DML ──────────────────────────────────────────────
do $w$
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
    execute format('grant select, insert, update, delete on public.%I to leadops_worker', t);
  end loop;
end
$w$;

grant select on public.settings, public.source_registry, public.profiles, public.leads
  to leadops_worker;
grant usage, select on all sequences in schema public to leadops_worker;

-- ❗ jobs 는 **INSERT/SELECT 만** 준다.
--    UPDATE 를 주면 fencing 을 우회해 좀비 워커가 결과를 덮어쓸 수 있다.
--    상태 전이는 acquire_job / heartbeat_job / complete_job RPC 로만 한다.
grant select, insert on public.jobs to leadops_worker;

-- ❗ 워커는 leads 에 쓰지 못한다. 리드는 승인 RPC 만 만든다.
-- ❗ 워커는 auth 스키마에 접근하지 못한다.

-- ── 함수 실행권 ──────────────────────────────────────────────────────────────
revoke execute on function public.decide_review_item(uuid, review_status, text, uuid) from public;
revoke execute on function public.enter_contact_email(uuid, text, email_type, uuid, text) from public;
revoke execute on function public.issue_review_nonce(uuid) from public;
revoke execute on function public.revoke_approval(uuid, text) from public;
revoke execute on function public.set_contact_basis(uuid, contact_basis, text) from public;
revoke execute on function public.export_leads(date, date) from public;
revoke execute on function public.update_setting(text, jsonb) from public;
revoke execute on function public.snapshot_settings() from public;
revoke execute on function public.reap_expired_jobs() from public;
revoke execute on function public.cleanup_old_data() from public;
revoke execute on function public.is_admin() from public;
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.setting_number(jsonb, text[]) from public;
revoke execute on function public.acquire_job(text, int) from public;
revoke execute on function public.heartbeat_job(bigint, bigint, text, int) from public;
revoke execute on function public.complete_job(bigint, bigint, text, boolean, text) from public;
revoke execute on function public.set_profile_role(uuid, user_role) from public;
revoke execute on function public.update_source_registry(text, boolean, text, text) from public;

-- 검수자(일반 사용자)가 쓰는 것
grant execute on function public.decide_review_item(uuid, review_status, text, uuid) to authenticated;
grant execute on function public.enter_contact_email(uuid, text, email_type, uuid, text) to authenticated;
grant execute on function public.issue_review_nonce(uuid) to authenticated;
grant execute on function public.is_admin() to authenticated;

-- admin 전용이지만 내부에서 is_admin() 을 검사하므로 authenticated 에 부여한다.
grant execute on function public.revoke_approval(uuid, text) to authenticated;
grant execute on function public.set_contact_basis(uuid, contact_basis, text) to authenticated;
grant execute on function public.export_leads(date, date) to authenticated;
grant execute on function public.update_setting(text, jsonb) to authenticated;

grant execute on function public.set_profile_role(uuid, user_role) to authenticated;
grant execute on function public.update_source_registry(text, boolean, text, text) to authenticated;

-- 워커 전용
grant execute on function public.snapshot_settings() to leadops_worker;
grant execute on function public.reap_expired_jobs() to leadops_worker;
grant execute on function public.cleanup_old_data() to leadops_worker;
grant execute on function public.acquire_job(text, int) to leadops_worker;
grant execute on function public.heartbeat_job(bigint, bigint, text, int) to leadops_worker;
grant execute on function public.complete_job(bigint, bigint, text, boolean, text) to leadops_worker;
