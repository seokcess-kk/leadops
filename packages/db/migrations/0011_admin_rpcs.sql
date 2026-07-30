-- 운영·설정 화면이 쓰는 RPC (설계서 7.2)
--
-- ❗ `authenticated` 에게는 어떤 테이블에도 쓰기 권한이 없다. 그래서 모든 쓰기는 여기처럼
--    SECURITY DEFINER 함수를 거친다. 함수 안에서 권한과 규칙을 검사하므로, API 를 우회해
--    RPC 를 직접 불러도 규칙이 유지된다.
--
-- ❗ 모든 쓰기는 `audit_log` 에 남긴다. 누가 언제 무엇을 바꿨는지 남지 않으면
--    운영 사고를 되짚을 수 없다.

-- ── 키워드 승인 (LLM 초안은 승인 전까지 검색에 쓰이지 않는다) ─────────────────
create or replace function public.approve_keyword(p_keyword_id uuid, p_approved boolean)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_before boolean;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select approved into strict v_before from company_keywords where id = p_keyword_id;
  update company_keywords set approved = p_approved where id = p_keyword_id;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'keyword.approve', 'company_keywords', p_keyword_id::text,
          jsonb_build_object('approved', v_before), jsonb_build_object('approved', p_approved));

  return jsonb_build_object('ok', true, 'approved', p_approved);
end;
$$;

-- ── 개인정보 요청 접수 (F-08) ────────────────────────────────────────────────
--
-- 열람·삭제·처리정지 요청은 **누구나 접수할 수 있어야 한다** (admin 전용이 아니다).
-- 접수 자체를 막으면 법정 권리 행사를 막는 것이 된다.
create or replace function public.create_privacy_request(
  p_kind text,
  p_subject_identifier text,
  p_note text default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_id uuid; v_company uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_kind not in ('access', 'delete', 'suspend', 'correct') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if coalesce(btrim(p_subject_identifier), '') = '' then
    raise exception 'subject_required' using errcode = '22023';
  end if;

  -- 식별자가 우리가 가진 이메일이면 업체를 연결해 둔다. 처리 담당자가 찾아 헤매지 않게.
  select e.company_id into v_company from emails e
   where e.address = p_subject_identifier::extensions.citext limit 1;

  -- ❗ 기한은 접수 시점에 못 박는다. 개인정보보호법 시행령 제41·43·44조는 열람·정정·삭제·
  --    처리정지를 **10일 내** 처리하도록 한다. 화면에서 계산하게 두면 기준이 흔들린다.
  insert into privacy_requests (kind, subject_identifier, company_id, evidence, due_at)
  values (p_kind, btrim(p_subject_identifier), v_company,
          case when p_note is null then '{}'::jsonb else jsonb_build_object('note', p_note) end,
          now() + interval '10 days')
  returning id into v_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'privacy.request', 'privacy_requests', v_id::text,
          jsonb_build_object('kind', p_kind, 'company_id', v_company));

  return jsonb_build_object('ok', true, 'request_id', v_id, 'company_id', v_company);
end;
$$;

-- ── 실행 취소 ────────────────────────────────────────────────────────────────
create or replace function public.cancel_run(p_run_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_status text; v_killed int;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select status::text into strict v_status from runs where id = p_run_id for update;
  -- ❗ 이미 끝난 실행을 취소하면 결과가 사라진 것처럼 보인다. 되돌릴 수 없는 상태는 막는다.
  if v_status in ('succeeded', 'partial', 'failed', 'cancelled') then
    raise exception 'run_not_cancellable' using errcode = '55000';
  end if;

  update runs set status = 'cancelled', finished_at = now() where id = p_run_id;

  -- 대기 중인 잡만 정리한다. 실행 중인 잡은 fencing 이 처리한다 —
  -- 여기서 강제로 죽이면 워커가 쓴 결과와 상태가 어긋난다.
  update jobs j set status = 'dead', last_error = coalesce(p_reason, 'run_cancelled')
   where j.attempt_id in (select id from run_attempts where run_id = p_run_id)
     and j.status = 'queued';
  get diagnostics v_killed = row_count;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'run.cancel', 'runs', p_run_id::text,
          jsonb_build_object('status', v_status),
          jsonb_build_object('status', 'cancelled', 'jobs_killed', v_killed));

  return jsonb_build_object('ok', true, 'jobs_killed', v_killed);
end;
$$;

-- ── 실행 재시도 (R2-21: 새 attempt 를 만들고 이전 결과를 무효화한다) ──────────
--
-- ❗ 같은 attempt 에 덮어쓰지 않는다. 모든 관측·결과 테이블의 유일키에 `attempt_id` 가
--    들어 있어 새 결과가 기존 행과 충돌하지 않고, 과거 점수도 그대로 재현된다.
create or replace function public.retry_run(p_run_id uuid, p_from_stage text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_prev uuid;
  v_attempt uuid;
  v_next int;
  v_jobs int := 0;
  v_row record;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select status::text into strict v_status from runs where id = p_run_id for update;
  if v_status = 'cancelled' then
    raise exception 'run_cancelled' using errcode = '55000';
  end if;

  select id, attempt_no into v_prev, v_next
    from run_attempts where run_id = p_run_id order by attempt_no desc limit 1;
  if v_prev is null then
    raise exception 'no_attempt' using errcode = '55000';
  end if;

  insert into run_attempts (run_id, attempt_no) values (p_run_id, v_next + 1) returning id into v_attempt;

  -- 이전 attempt 의 점수를 무효화한다. 승인 RPC 가 무효 점수를 거부하므로,
  -- 재실행 중에 낡은 점수로 승인이 나가는 것을 막는다.
  update scores set invalidated_at = now()
   where run_id = p_run_id and attempt_id = v_prev and invalidated_at is null;

  -- 진행 화면이 "아직 시작 안 함" 을 보여줄 수 있게 스테이지 행을 미리 만든다.
  insert into run_stages (attempt_id, stage, status)
  select v_attempt, s.stage, 'pending' from run_stages s where s.attempt_id = v_prev
  on conflict (attempt_id, stage) do nothing;

  if p_from_stage = 'collect' then
    -- collect 는 업종별 payload 가 있다. 이전 attempt 의 잡에서 그대로 가져온다.
    for v_row in
      select idempotency_key, payload from jobs
       where attempt_id = v_prev and stage = 'collect'
    loop
      insert into jobs (attempt_id, stage, idempotency_key, payload)
      values (v_attempt, 'collect', v_row.idempotency_key, v_row.payload)
      on conflict (attempt_id, stage, idempotency_key) do nothing;
      v_jobs := v_jobs + 1;
    end loop;
  else
    insert into jobs (attempt_id, stage, idempotency_key, payload)
    values (v_attempt, p_from_stage, p_from_stage || ':all', '{}'::jsonb)
    on conflict (attempt_id, stage, idempotency_key) do nothing;
    v_jobs := 1;
  end if;

  if v_jobs = 0 then
    raise exception 'nothing_to_retry' using errcode = '55000';
  end if;

  update run_stages set status = 'running', total = v_jobs, started_at = now()
   where attempt_id = v_attempt and stage = p_from_stage;
  update runs set status = 'running', finished_at = null where id = p_run_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'run.retry', 'runs', p_run_id::text,
          jsonb_build_object('attempt_id', v_attempt, 'from_stage', p_from_stage, 'jobs', v_jobs));

  return jsonb_build_object('ok', true, 'attempt_id', v_attempt, 'jobs', v_jobs);
end;
$$;

-- ── 경쟁사 수동 교체 ─────────────────────────────────────────────────────────
--
-- 초기 실행에서는 유효 경쟁사가 부족해 대부분이 게이트에서 탈락한다. admin 이 직접
-- 비교 대상을 지정할 수 있어야 그 업체를 살릴 수 있다.
create or replace function public.replace_competitor(
  p_attempt_id uuid,
  p_company_id uuid,
  p_rank int,
  p_competitor_company_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_name text; v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_competitor_company_id = p_company_id then
    raise exception 'self_is_not_competitor' using errcode = '22023';
  end if;

  select name into strict v_name from companies where id = p_competitor_company_id;

  insert into competitors (
    attempt_id, company_id, competitor_company_id, competitor_name,
    selection_method, similarity, rank, is_valid
  ) values (
    p_attempt_id, p_company_id, p_competitor_company_id, v_name,
    'manual', jsonb_build_object('by', auth.uid()), p_rank, false
  )
  on conflict (attempt_id, company_id, rank) do update
    set competitor_company_id = excluded.competitor_company_id,
        competitor_name = excluded.competitor_name,
        selection_method = 'manual',
        similarity = excluded.similarity,
        -- ❗ 교체하면 지표를 다시 계산해야 한다. 유효로 표시해 두면 이전 경쟁사의
        --    지표가 새 경쟁사의 것처럼 쓰인다.
        is_valid = false
  returning id into v_id;

  delete from competitor_metrics where competitor_id = v_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'competitor.replace', 'competitors', v_id::text,
          jsonb_build_object('company_id', p_company_id, 'rank', p_rank,
                             'competitor_company_id', p_competitor_company_id));

  return jsonb_build_object('ok', true, 'competitor_id', v_id, 'needs_reanalysis', true);
end;
$$;

-- ── 실행권 ───────────────────────────────────────────────────────────────────
do $g$
declare sig text;
begin
  foreach sig in array array[
    'public.approve_keyword(uuid, boolean)',
    'public.create_privacy_request(text, text, text)',
    'public.cancel_run(uuid, text)',
    'public.retry_run(uuid, text)',
    'public.replace_competitor(uuid, uuid, int, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', sig);
    execute format('grant execute on function %s to authenticated', sig);
  end loop;
end
$g$;
