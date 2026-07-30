-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7 — 운영 · 개인정보 · 용량
--
-- 세 덩어리다:
--   (1) 개인정보 열람·삭제·처리정지 **집행** (R6 · 설계서 1.5 · 개인정보보호법)
--   (2) DB 용량 게이트 (설계서 4.2 — Free 500MB 로는 6개월을 못 버틴다)
--   (3) 스케줄 판정 (평일 06:00 KST · 중복 실행 방지)
--
-- ❗ pg_cron 스케줄 등록은 여기 없다. 로컬 컨테이너에 pg_cron 이 없어 검증할 수 없고,
--    검증하지 못한 것을 마이그레이션 체인에 넣으면 배포에서 처음 실행된다.
--    → `packages/db/migrations/deploy/` 의 배포 전용 스크립트로 분리했다.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────── (1) 개인정보 집행
--
-- 접수(`create_privacy_request`)만 있고 **집행이 없었다.** 접수만 되는 워크플로는
-- 법적 의무를 이행한 것이 아니다. 여기서 상태 전이와 실제 처리를 함께 못 박는다.
--
-- 상태: received → in_progress → { completed | rejected | on_hold }
--
-- ❗ `legal_hold` 는 삭제를 **막는다**. 보존 의무가 있는 자료(분쟁·수사 협조)를 삭제 요청으로
--    지울 수 있으면 그 자체가 위법이다. 대신 사유를 남기고 `on_hold` 로 둔다.

create or replace function public.advance_privacy_request(
  p_request_id uuid,
  p_status text,
  p_note text default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_before record; v_now timestamptz := now();
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 접수는 `create_privacy_request` 만 한다. 여기서 되돌리면 접수 시각·기한이 흔들린다.
  if p_status not in ('in_progress', 'on_hold', 'completed', 'rejected') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  select * into v_before from privacy_requests where id = p_request_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- 종결된 요청은 다시 열지 않는다. 처리 이력이 사실이어야 한다.
  if v_before.status in ('completed', 'rejected') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  -- 보류·거절은 사유 없이 존재할 수 없다. 사유 없는 미처리가 가장 위험한 상태다.
  if p_status in ('on_hold', 'rejected') and coalesce(btrim(p_note), '') = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  update privacy_requests set
    status = p_status,
    hold_reason = case when p_status in ('on_hold', 'rejected') then btrim(p_note) else null end,
    completed_at = case when p_status in ('completed', 'rejected') then v_now else null end,
    completed_by = case when p_status in ('completed', 'rejected') then auth.uid() else null end
  where id = p_request_id;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'privacy.advance', 'privacy_requests', p_request_id::text,
          jsonb_build_object('status', v_before.status),
          jsonb_build_object('status', p_status, 'note', p_note));

  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

-- 열람(access) — 우리가 그 주체에 대해 **무엇을 가지고 있는지** 그대로 보여 준다.
--
-- ❗ 마스킹하지 않는다. 열람권은 본인 확인을 거친 정보주체가 자기 정보를 보는 권리이므로,
--    가린 채로 주면 이행한 것이 아니다. 대신 실행 자체를 audit_log 에 남긴다.
-- ❗ 우리가 이메일을 자동 수집하지 않으므로(정보통신망법 50조의2) 보유 항목은 검수자가 입력한
--    업무용 주소와 그 근거뿐이다. 그 사실도 함께 돌려준다.
create or replace function public.privacy_access_report(p_request_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_req record; v_report jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_req from privacy_requests where id = p_request_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'subject_identifier', v_req.subject_identifier,
    'company', (
      select jsonb_build_object('id', c.id, 'name', c.name, 'industry', c.industry,
                               'do_not_contact', c.do_not_contact, 'opt_out_at', c.opt_out_at)
      from companies c where c.id = v_req.company_id
    ),
    'emails', coalesce((
      select jsonb_agg(jsonb_build_object(
        'address', e.address, 'email_type', e.email_type,
        'acquisition_method', e.acquisition_method,
        'collection_legal_basis', e.collection_legal_basis,
        'entered_at', e.entered_at, 'retention_until', e.retention_until,
        'source_url', (select cp.url from contact_pages cp where cp.id = e.source_contact_page_id)
      ) order by e.created_at)
      from emails e
      where e.address = v_req.subject_identifier::extensions.citext
         or (v_req.company_id is not null and e.company_id = v_req.company_id)
    ), '[]'::jsonb),
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'approval_date', l.approval_date,
        'contact_legal_basis', l.contact_legal_basis,
        'export_status', l.export_status, 'export_count', l.export_count,
        'retention_until', l.retention_until) order by l.approval_date)
      from leads l where v_req.company_id is not null and l.company_id = v_req.company_id
    ), '[]'::jsonb),
    'note', '시스템은 홈페이지에서 이메일을 자동 수집하지 않습니다 (정보통신망법 제50조의2). '
            || '보유한 주소는 검수자가 공개된 연락처 페이지에서 확인해 직접 입력한 업무용 주소입니다.'
  ) into v_report;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'privacy.access', 'privacy_requests', p_request_id::text,
          jsonb_build_object('emails', jsonb_array_length(v_report -> 'emails'),
                             'leads', jsonb_array_length(v_report -> 'leads')));

  return v_report;
end;
$$;

-- 삭제·처리정지 **집행**.
--
--   delete   개인정보를 파기하고 재수집을 영구히 막는다
--   suspend  처리를 멈춘다 (파기하지 않고 접촉·export 만 차단)
--
-- ❗ `delete` 도 `companies` 행 자체는 지우지 않는다. 지우면 **재수집 대상이 되어 같은 업체가
--    다시 올라온다** — 삭제 요청을 이행한 결과가 재수집이면 이행한 것이 아니다.
--    개인정보(이메일)를 파기하고 `do_not_contact` 로 영구 차단하는 것이 올바른 이행이다.
-- ❗ `legal_hold` 가 걸린 이메일은 파기하지 않고 건수를 돌려준다. 조용히 남기지 않는다.
create or replace function public.execute_privacy_request(p_request_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_req record;
  v_emails_deleted int := 0;
  v_emails_held int := 0;
  v_leads_blocked int := 0;
  v_actions jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_req from privacy_requests where id = p_request_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_req.status in ('completed', 'rejected') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if v_req.kind not in ('delete', 'suspend') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  -- 보존 의무가 걸린 요청은 집행하지 않는다. 사유를 달아 on_hold 로 두는 것이 올바른 처리다.
  if v_req.legal_hold then
    raise exception 'legal_hold' using errcode = '55000';
  end if;
  -- 업체가 특정되지 않으면 무엇을 지울지 알 수 없다. 조용히 0건 처리하지 않는다.
  if v_req.company_id is null then
    raise exception 'subject_not_matched' using errcode = '55000';
  end if;

  -- ❗ 접촉 차단이 먼저다. 파기 도중 실패해도 접촉은 이미 막혀 있어야 한다.
  update companies
     set do_not_contact = true,
         opt_out_at = coalesce(opt_out_at, now()),
         -- 재평가 풀로 돌아오지 못하게 한다.
         next_eligible_at = now() + interval '100 years'
   where id = v_req.company_id;

  -- export 가 이미 나간 리드는 되돌릴 수 없다. 앞으로 나가지 못하게만 한다
  -- (`export_leads()` 는 `do_not_contact`·`opt_out_at` 을 게이트로 본다).
  select count(*) into v_leads_blocked from leads where company_id = v_req.company_id;

  if v_req.kind = 'delete' then
    select count(*) into v_emails_held
      from emails where company_id = v_req.company_id and legal_hold is true;

    delete from emails where company_id = v_req.company_id and legal_hold is not true;
    get diagnostics v_emails_deleted = row_count;
  end if;

  v_actions := jsonb_build_object(
    'kind', v_req.kind,
    'executed_at', now(),
    'do_not_contact', true,
    'emails_deleted', v_emails_deleted,
    'emails_retained_legal_hold', v_emails_held,
    'leads_blocked_from_export', v_leads_blocked
  );

  update privacy_requests
     set actions_taken = actions_taken || jsonb_build_array(v_actions),
         status = 'completed',
         completed_at = now(),
         completed_by = auth.uid()
   where id = p_request_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'privacy.execute', 'privacy_requests', p_request_id::text, v_actions);

  return v_actions;
end;
$$;

-- ───────────────────────────────────────────────── (2) 용량 게이트
--
-- 설계서 4.2: 정상상태로 180일이면 약 620MB — Supabase Free 500MB 를 넘긴다.
-- 넘긴 뒤에 알면 늦으므로 임계값을 코드로 못 박는다.
--
--   < 70%  ok        평시
--   ≥ 70%  warn      알람 (운영자가 손을 쓸 시간)
--   ≥ 85%  cleanup   정리 잡이 보존기간을 공격적으로 줄인다
--   ≥ 90%  block     **신규 실행 차단** — 쓰기가 막히기 전에 우리가 먼저 멈춘다

create or replace function public.db_capacity(p_limit_bytes bigint default null)
returns jsonb
language plpgsql security definer
-- ❗ `pg_catalog` 를 적지 않는다. Postgres 는 명시하지 않아도 pg_catalog 를 **항상 먼저**
--    검색하므로 불필요하고, 스키마 린트가 `search_path=public, pg_temp` 만 허용한다
--    (`schema.pg.test.ts` — 값이 다르면 실패한다).
set search_path = public, pg_temp
as $$
declare
  v_bytes bigint;
  v_limit bigint;
  v_pct numeric;
begin
  v_bytes := pg_database_size(current_database());
  -- 상한은 설정으로 바꿀 수 있다. Supabase Free 500MB → self-host 이전 시 올린다.
  v_limit := coalesce(
    p_limit_bytes,
    (select (value #>> '{capacity,limit_bytes}')::bigint from settings where key = 'capacity'),
    524288000  -- 500 MB
  );
  if v_limit <= 0 then
    raise exception 'configuration_error' using errcode = '22023',
      detail = 'capacity.limit_bytes 가 0 이하입니다';
  end if;

  v_pct := round((v_bytes::numeric / v_limit::numeric) * 100, 2);

  return jsonb_build_object(
    'bytes', v_bytes,
    'limit_bytes', v_limit,
    'pct', v_pct,
    'level', case
      when v_pct >= 90 then 'block'
      when v_pct >= 85 then 'cleanup'
      when v_pct >= 70 then 'warn'
      else 'ok'
    end
  );
end;
$$;

-- 테이블별 용량 리포트. "무엇이 먹고 있는지" 를 모르면 보존기간을 조정할 근거가 없다.
create or replace function public.capacity_report()
returns jsonb
language plpgsql security definer
-- ❗ `pg_catalog` 를 적지 않는다. Postgres 는 명시하지 않아도 pg_catalog 를 **항상 먼저**
--    검색하므로 불필요하고, 스키마 린트가 `search_path=public, pg_temp` 만 허용한다
--    (`schema.pg.test.ts` — 값이 다르면 실패한다).
set search_path = public, pg_temp
as $$
declare v_tables jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_agg(t order by (t ->> 'total_bytes')::bigint desc) into v_tables
  from (
    select jsonb_build_object(
      'table', c.relname,
      'total_bytes', pg_total_relation_size(c.oid),
      'table_bytes', pg_table_size(c.oid),
      'index_bytes', pg_indexes_size(c.oid),
      'live_rows', greatest(c.reltuples, 0)::bigint
    ) as t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  ) s;

  return jsonb_build_object(
    'capacity', public.db_capacity(),
    'tables', coalesce(v_tables, '[]'::jsonb)
  );
end;
$$;

-- ❗ 신규 실행 차단. 실행을 만들기 전에 **반드시** 통과해야 한다.
--    용량이 꽉 찬 뒤에 멈추면 그 순간의 쓰기가 실패하면서 중간 상태가 남는다.
create or replace function public.assert_capacity_for_run()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_cap jsonb;
begin
  v_cap := public.db_capacity();
  if v_cap ->> 'level' = 'block' then
    raise exception 'capacity_exceeded' using errcode = '53100',
      detail = format('DB 용량 %s%% (%s / %s bytes). 정리 후 다시 실행하세요.',
                      v_cap ->> 'pct', v_cap ->> 'bytes', v_cap ->> 'limit_bytes');
  end if;
  return v_cap;
end;
$$;

-- 용량 인식 정리 잡.
--
-- ❗ 기본 보존기간은 그대로 두고, **`cleanup` 레벨에서만** 더 줄인다. 평시에 공격적으로
--    지우면 회귀 테스트 입력(관측 이력)과 감사 추적이 사라진다.
create or replace function public.cleanup_by_capacity()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_cap jsonb;
  v_base jsonb;
  v_aggressive jsonb := '{}'::jsonb;
  v_hits int := 0; v_aggs int := 0; v_obs int := 0;
begin
  v_cap := public.db_capacity();
  v_base := public.cleanup_old_data();

  if (v_cap ->> 'level') in ('cleanup', 'block') then
    -- 관련 문서 30일 → 7일, 집계·관측 365일 → 120일.
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
          jsonb_build_object('before', v_cap, 'base', v_base, 'aggressive', v_aggressive,
                             'after', public.db_capacity()));

  return jsonb_build_object(
    'capacity_before', v_cap,
    'base', v_base,
    'aggressive', v_aggressive,
    'capacity_after', public.db_capacity()
  );
end;
$$;

-- ───────────────────────────────────────────────── (3) 스케줄 판정
--
-- pg_cron 은 "평일 06:00 KST 에 이걸 불러라" 만 안다. **불러도 되는지**는 여기서 정한다.
-- 판정을 cron 표현식에 흘려 넣으면 (a) 검증할 수 없고 (b) 스케줄을 바꿀 때마다 규칙이 흔들린다.

create or replace function public.should_start_scheduled_run()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb;
  v_enabled boolean;
  v_kst date := (now() at time zone 'Asia/Seoul')::date;
  v_dow int := extract(isodow from (now() at time zone 'Asia/Seoul'));
  v_cap jsonb;
  v_existing uuid;
  v_reasons text[] := '{}';
begin
  select value into v_settings from settings where key = 'schedule';
  v_enabled := coalesce((v_settings ->> 'enabled')::boolean, false);

  -- ❗ `::text` 캐스트가 필요하다. `text[] || '리터럴'` 은 Postgres 가 오른쪽을 **배열
  --    리터럴**로 파싱하려 해서 `malformed array literal` 로 깨진다.
  if not v_enabled then
    v_reasons := v_reasons || 'schedule_disabled'::text;
  end if;
  -- 평일만. isodow 6·7 = 토·일 (KST 기준 — UTC 로 판정하면 월요일 새벽이 일요일이 된다).
  if v_dow > 5 then
    v_reasons := v_reasons || 'not_a_weekday'::text;
  end if;

  -- 같은 날 cron 실행이 이미 있으면 만들지 않는다. `runs_one_cron_per_day` 가 최종 방어선이고
  -- 여기서는 예외 대신 사유로 돌려준다 (cron 이 실패 알림을 울릴 이유가 없다).
  select id into v_existing from runs where run_date = v_kst and trigger = 'cron' limit 1;
  if v_existing is not null then
    v_reasons := v_reasons || 'already_ran_today'::text;
  end if;

  v_cap := public.db_capacity();
  if v_cap ->> 'level' = 'block' then
    v_reasons := v_reasons || 'capacity_blocked'::text;
  end if;

  return jsonb_build_object(
    'should_run', cardinality(v_reasons) = 0,
    'run_date', v_kst,
    'isodow', v_dow,
    'reasons', to_jsonb(v_reasons),
    'capacity', v_cap,
    'existing_run_id', v_existing
  );
end;
$$;

-- ───────────────────────────────────────────────── 설정 · 권한

insert into settings (key, value) values
  ('capacity', jsonb_build_object('limit_bytes', 524288000, 'warn_pct', 70, 'cleanup_pct', 85, 'block_pct', 90))
on conflict (key) do nothing;

-- ❗ 기본 거부 후 필요한 역할에만 부여한다. `public` 에 남으면 익명도 호출할 수 있다.
do $g$
declare sig text;
begin
  foreach sig in array array[
    'public.advance_privacy_request(uuid, text, text)',
    'public.privacy_access_report(uuid)',
    'public.execute_privacy_request(uuid)',
    'public.capacity_report()',
    'public.db_capacity(bigint)',
    'public.assert_capacity_for_run()',
    'public.cleanup_by_capacity()',
    'public.should_start_scheduled_run()'
  ]
  loop
    execute format('revoke all on function %s from public, anon', sig);
  end loop;
end
$g$;

-- 개인정보·용량 조회는 내부에서 is_admin() 을 검사하므로 authenticated 에 준다.
grant execute on function public.advance_privacy_request(uuid, text, text) to authenticated;
grant execute on function public.privacy_access_report(uuid) to authenticated;
grant execute on function public.execute_privacy_request(uuid) to authenticated;
grant execute on function public.capacity_report() to authenticated;

-- ❗ 워커 전용. 스케줄 판정·정리·용량 게이트는 사용자가 부를 이유가 없고,
--    `cleanup_by_capacity` 는 데이터를 지우므로 authenticated 에 주면 안 된다.
grant execute on function public.db_capacity(bigint) to leadops_worker;
grant execute on function public.assert_capacity_for_run() to leadops_worker;
grant execute on function public.cleanup_by_capacity() to leadops_worker;
grant execute on function public.should_start_scheduled_run() to leadops_worker;
