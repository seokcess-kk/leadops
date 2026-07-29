-- ─────────────────────────────────────────────────────────────────────────────
-- 원본 후보 (설계서 5.3 스테이지 1 → 2 인계)
--
-- `collect` 가 어댑터에서 받은 원본을 여기에 넣고, `normalize` 가 읽어
-- companies 로 승격시킨다. 두 스테이지를 분리해야 각각 독립적으로 재실행된다.
--
-- 용량(R9): 원본 jsonb 를 들고 있으므로 **7일만 보관**한다. 그 이후에는
-- companies 와 company_observations 에 필요한 것이 모두 남아 있다.
-- ─────────────────────────────────────────────────────────────────────────────

create table raw_candidates (
  id bigserial primary key,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  source text not null,
  external_id text not null,
  industry text not null,
  -- 정규화 전 원본. 매핑 오류를 사후에 추적하기 위해 필요하다.
  payload jsonb not null,
  -- normalize 스테이지가 처리한 뒤 남기는 결과. null 이면 아직 미처리.
  normalized_at timestamptz,
  company_id uuid references companies(id) on delete set null,
  skip_reason text,
  created_at timestamptz not null default now(),
  -- F-16: collect 재실행 시 중복 적재를 막는다.
  unique (attempt_id, source, external_id)
);
create index raw_candidates_pending on raw_candidates (attempt_id) where normalized_at is null;
create index raw_candidates_cleanup on raw_candidates (created_at);

alter table raw_candidates enable row level security;

-- 검수 화면에서 "왜 이 업체가 이렇게 들어왔나" 를 추적할 수 있어야 한다.
create policy raw_candidates_read on raw_candidates for select to authenticated using (true);
create policy raw_candidates_worker on raw_candidates for all to leadops_worker
  using (true) with check (true);

grant select on raw_candidates to authenticated;
grant select, insert, update, delete on raw_candidates to leadops_worker;
grant usage, select on sequence raw_candidates_id_seq to leadops_worker;

-- 정리 잡에 포함시킨다.
create or replace function public.cleanup_old_data() returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_hits int; v_aggs int; v_obs int; v_cache int; v_audit int; v_raw int;
begin
  delete from search_hits where collected_at < now() - interval '30 days';
  get diagnostics v_hits = row_count;

  delete from search_aggregates where collected_at < now() - interval '365 days';
  get diagnostics v_aggs = row_count;

  delete from company_observations where observed_at < now() - interval '365 days';
  get diagnostics v_obs = row_count;

  delete from http_cache where expires_at < now();
  get diagnostics v_cache = row_count;

  delete from audit_log where created_at < now() - interval '365 days';
  get diagnostics v_audit = row_count;

  delete from raw_candidates where created_at < now() - interval '7 days';
  get diagnostics v_raw = row_count;

  delete from review_view_nonces where expires_at < now();

  return jsonb_build_object(
    'search_hits', v_hits, 'search_aggregates', v_aggs,
    'company_observations', v_obs, 'http_cache', v_cache,
    'audit_log', v_audit, 'raw_candidates', v_raw
  );
end;
$$;
revoke execute on function public.cleanup_old_data() from public;
grant execute on function public.cleanup_old_data() to leadops_worker;
