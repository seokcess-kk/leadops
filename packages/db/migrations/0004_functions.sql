-- ─────────────────────────────────────────────────────────────────────────────
-- RPC 함수 (설계서 6.3 v3)
--
-- 모든 함수는 SECURITY DEFINER + search_path 고정 + REVOKE EXECUTE FROM PUBLIC.
-- 이를 검사하는 린트가 통합 테스트에 있다.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────── 설정 안전 파싱
--
-- JSON 값을 곧바로 int/numeric 으로 캐스팅하면, 값이 문자열이거나 형식이 틀렸을 때
-- 정제되지 않은 `22P02 invalid_text_representation` 이 튀어나온다.
-- 호출자가 "설정 문제"임을 알 수 있도록 일관된 configuration_error 로 바꾼다.
create or replace function public.setting_number(p_settings jsonb, p_path text[])
returns numeric
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  v := p_settings #> p_path;
  if v is null or jsonb_typeof(v) <> 'number' then
    raise exception 'configuration_error' using
      errcode = '22023',
      detail = format('설정 %s 가 없거나 숫자가 아닙니다', array_to_string(p_path, '.'));
  end if;
  return v::text::numeric;
end;
$$;

-- ─────────────────────────────────────────────────────── 검수 결정
--
-- v2 의 버그 4개를 모두 고친 버전:
--   R2-01  (cnt+1)/(total+1) > share_max  → 첫 승인부터 항상 거부됐다.
--          순서 독립적인 절대 쿼터 floor(cap × share_max) 로 교체.
--   R2-17  on conflict do nothing 이 승인 실패를 성공으로 위장했다.
--          → ON CONFLICT 제거 + ROW_COUNT 검증.
--   R2-18  카운터가 run 기준이라 수동 run 을 추가하면 상한이 우회됐다.
--          → 승인일 기준.
--   R2-19  설정이 NULL 이면 `x >= NULL` → NULL → IF false → 상한 검사 fail-open.
--          → INTO STRICT + 범위 검증 + configuration_error.
--
-- 추가로 v3 자체 결함(서로 다른 업종의 동시 승인이 일 총량을 넘김)을 잠금 순서 고정으로 해결.
create or replace function public.decide_review_item(
  p_item_id uuid,
  p_status review_status,
  p_reason text default null,
  p_email_id uuid default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_item review_items%rowtype;
  v_settings jsonb;
  v_industry text;
  v_cap int;
  v_share_max numeric;
  v_industry_quota int;
  v_industry_cnt int;
  v_day_total int;
  v_cooldown_days int;
  v_retention_days int;
  v_score scores%rowtype;
  v_rows int;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- R2-16: 허용 전이를 명시적으로 제한한다. pending 재설정·approved→approved 방지.
  if p_status not in ('approved', 'rejected') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  select * into v_item from review_items where id = p_item_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- 재판정은 revoke_approval() 로만. 관리자도 여기서는 예외가 없다.
  if v_item.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;

  -- R2-19: 설정은 run 의 동결 스냅샷에서 STRICT 로 읽는다. 누락·형식오류면 fail-closed.
  select settings_snapshot into strict v_settings from runs where id = v_item.run_id;
  v_cap            := public.setting_number(v_settings, '{targets,final_max}')::int;
  v_share_max      := public.setting_number(v_settings, '{targets,industry_share_max}');
  v_cooldown_days  := public.setting_number(v_settings, '{targets,cooldown_rejected_days}')::int;
  v_retention_days := public.setting_number(v_settings, '{privacy,lead_retention_days}')::int;

  if v_cap <= 0 or v_share_max <= 0 or v_share_max > 1
     or v_cooldown_days < 0 or v_retention_days <= 0 then
    raise exception 'configuration_error' using errcode = '22023', detail = '설정 값이 허용 범위를 벗어났습니다';
  end if;

  select industry into strict v_industry from companies where id = v_item.company_id;

  if p_status = 'approved' then
    if p_email_id is null then
      raise exception 'email_required' using errcode = '22023';
    end if;
    perform 1 from emails e
      where e.id = p_email_id and e.company_id = v_item.company_id and e.mx_ok is true;
    if not found then
      raise exception 'email_not_verified' using errcode = '22023';
    end if;

    -- ❗ 점수를 잠그고 유효성을 다시 확인한다.
    --    워커가 scores 를 갱신·무효화할 수 있으므로, 검수 화면에서 본 점수가
    --    승인 시점에도 유효한지 확인하지 않으면 무효화된 근거로 리드가 만들어진다.
    select * into strict v_score from scores where id = v_item.score_id for share;
    if v_score.invalidated_at is not null then
      raise exception 'score_invalidated' using errcode = '55000';
    end if;
    if not v_score.gate_passed then
      raise exception 'score_gate_not_passed' using errcode = '55000';
    end if;

    -- 같은 (company, run) 리드가 이미 있으면 정제되지 않은 unique_violation 대신
    -- 도메인 오류를 낸다. 재실행 attempt 에서 같은 업체가 다시 올라올 수 있다.
    perform 1 from leads where company_id = v_item.company_id and run_id = v_item.run_id;
    if found then
      raise exception 'lead_already_exists' using errcode = '55000';
    end if;

    v_industry_quota := floor(v_cap * v_share_max);   -- 50 × 0.6 = 30

    -- ❗ 잠금 순서 고정: (1) 일 총량 행 → (2) 업종 행. 항상 같은 순서라 교착이 없다.
    insert into approval_day_totals (approval_date) values (current_date)
      on conflict (approval_date) do nothing;
    select approved_total into strict v_day_total
      from approval_day_totals where approval_date = current_date
      for update;
    if v_day_total >= v_cap then
      raise exception 'daily_cap_reached' using errcode = '55000';
    end if;

    insert into approval_counters (approval_date, industry) values (current_date, v_industry)
      on conflict (approval_date, industry) do nothing;
    select approved_count into strict v_industry_cnt
      from approval_counters
      where approval_date = current_date and industry = v_industry
      for update;
    if v_industry_cnt + 1 > v_industry_quota then
      raise exception 'industry_quota_exceeded' using errcode = '55000';
    end if;

    -- R2-17: ON CONFLICT 없음. 정확히 1행이 아니면 전체 트랜잭션을 실패시킨다.
    insert into leads (
      run_id, company_id, review_item_id, email_id, score, snapshot,
      approval_date, approved_industry,
      contact_legal_basis, retention_until
    )
    values (
      v_item.run_id, v_item.company_id, v_item.id, p_email_id, v_score.total,
      jsonb_build_object('score', to_jsonb(v_score), 'decided_at', now()),
      -- 취소 시 되돌릴 카운터 좌표를 고정한다.
      current_date, v_industry,
      -- D-001 로 콜드 아웃바운드를 적법하다고 판단했으나, 근거 필드는 유지한다.
      -- 값 자체는 설정으로 바꿀 수 있게 두어 되돌릴 수 있게 한다.
      coalesce((v_settings #>> '{privacy,default_contact_basis}')::contact_basis,
               'pending_legal_review'::contact_basis),
      current_date + v_retention_days
    );
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'lead_insert_failed' using errcode = '55000';
    end if;

    update approval_counters set approved_count = approved_count + 1
      where approval_date = current_date and industry = v_industry;
    update approval_day_totals set approved_total = approved_total + 1
      where approval_date = current_date;
  else
    -- 결론 D: 제외한 업체는 cooldown 후에야 재평가 대상이 된다.
    update companies
      set next_eligible_at = now() + make_interval(days => v_cooldown_days)
      where id = v_item.company_id;
  end if;

  update review_items
    set status = p_status,
        decided_by = auth.uid(),
        decided_at = now(),
        reject_reason = p_reason
    where id = p_item_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'review.decide', 'review_items', p_item_id::text,
          jsonb_build_object('status', p_status, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

-- ─────────────────────────────────────────────────────── 연락처 수동 입력
--
-- 설계서 결론 A: 홈페이지에서 프로그램으로 이메일을 수집하지 않는다.
-- 검수자가 페이지를 직접 열어 보고 입력한다.
--
-- R2-08: `acquisition_method='manual_entry'` 는 호출자가 고른 라벨일 뿐이므로,
--        함수가 행위자·대상 페이지·시각을 결속하고 자동화된 대량 호출을 막아야 한다.
create or replace function public.enter_contact_email(
  p_review_item_id uuid,
  p_address text,
  p_email_type email_type,
  p_contact_page_id uuid,
  p_nonce text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_item review_items%rowtype;
  v_page contact_pages%rowtype;
  v_domain text;
  v_local text;
  v_recent int;
  v_email_id uuid;
  v_rate_limit int;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- 1) 검수 화면을 실제로 연 세션인지 확인한다 (1회용 nonce).
  --    ❗ 검증과 소비를 **한 문장**으로 한다. 확인 후 갱신으로 나누면 두 요청이
  --      모두 `used_at is null` 을 통과한 뒤 각자 진행할 수 있다.
  update review_view_nonces
    set used_at = now()
    where nonce = p_nonce
      and review_item_id = p_review_item_id
      and user_id = auth.uid()
      and used_at is null
      and expires_at > now();
  if not found then
    raise exception 'invalid_nonce' using errcode = '28000';
  end if;

  -- 2) 사람이 페이지를 읽는 속도의 상한. 자동화된 대량 입력을 막는다.
  --    ❗ 같은 사용자의 동시 호출을 직렬화한다. 없으면 병렬 호출이 모두 같은
  --      count 를 읽고 함께 통과한다.
  perform pg_advisory_xact_lock(hashtext('manual_email:' || auth.uid()::text));

  v_rate_limit := coalesce(
    (select (value #>> '{review,manual_email_per_minute}')::int from settings where key = 'review'), 3);

  -- ❗ 변경 가능한 emails.entered_at 이 아니라 추가 전용 이벤트를 센다.
  --    (재입력은 UPDATE 라 행 수가 늘지 않아 과소 계산되고,
  --     다른 적재 경로가 entered_by 를 쓰면 과대 계산된다.)
  select count(*) into v_recent from manual_entry_events
    where user_id = auth.uid() and created_at > now() - interval '1 minute';
  if v_recent >= v_rate_limit then
    raise exception 'rate_limited' using errcode = '53400';
  end if;
  insert into manual_entry_events (user_id, review_item_id)
    values (auth.uid(), p_review_item_id);

  select * into strict v_item from review_items where id = p_review_item_id;
  select * into strict v_page from contact_pages where id = p_contact_page_id;

  -- 3) 그 연락처 페이지가 정말 이 업체의 것인지 확인한다.
  perform 1 from websites w
    where w.id = v_page.website_id and w.company_id = v_item.company_id;
  if not found then
    raise exception 'page_company_mismatch' using errcode = '22023';
  end if;

  -- 4) 문법 검증. DNS·MX 는 워커가 비동기로 채운다.
  if p_address !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_syntax' using errcode = '22023';
  end if;
  v_local  := split_part(p_address, '@', 1);
  v_domain := lower(split_part(p_address, '@', 2));

  insert into emails (
    company_id, address, local_part, domain, email_type,
    acquisition_method, collection_legal_basis,
    entered_by, entered_at, source_contact_page_id,
    domain_match, is_free_mail, syntax_ok,
    is_personal_data, retention_until
  )
  values (
    v_item.company_id, p_address, v_local, v_domain, p_email_type,
    'manual_entry', 'manual_from_public_site',
    auth.uid(), now(), p_contact_page_id,
    exists (select 1 from websites w where w.company_id = v_item.company_id and w.domain = v_domain),
    v_domain = any (array['gmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'nate.com']),
    true,
    -- 담당자 개인 주소는 개인정보로 판정한다.
    p_email_type = 'staff',
    current_date + 365
  )
  -- 충돌 시에도 현재 행위자·페이지·시각을 다시 결속한다.
  -- 라벨만 남고 증거가 갱신되지 않으면 manual_entry 주장이 검증 불가능해진다.
  on conflict (company_id, address) do update
    set email_type             = excluded.email_type,
        entered_by             = excluded.entered_by,
        entered_at             = excluded.entered_at,
        source_contact_page_id = excluded.source_contact_page_id,
        acquisition_method     = excluded.acquisition_method,
        collection_legal_basis = excluded.collection_legal_basis
  returning id into v_email_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'email.manual_entry', 'emails', v_email_id::text,
          jsonb_build_object('company_id', v_item.company_id,
                             'contact_page_id', p_contact_page_id));

  return jsonb_build_object('ok', true, 'email_id', v_email_id);
end;
$$;

-- 검수 화면 진입 시 nonce 발급.
create or replace function public.issue_review_nonce(p_review_item_id uuid)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_nonce text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  perform 1 from review_items where id = p_review_item_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- gen_random_uuid() 는 PG13+ 내장이고 암호학적으로 안전한 난수를 쓴다.
  -- pgcrypto 확장을 요구하지 않기 위해 두 개를 이어 붙여 244비트 엔트로피를 만든다.
  v_nonce := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into review_view_nonces (nonce, review_item_id, user_id, expires_at)
  values (
    v_nonce, p_review_item_id, auth.uid(),
    now() + make_interval(mins => coalesce(
      (select (value #>> '{review,nonce_ttl_minutes}')::int from settings where key = 'review'), 30))
  );
  return v_nonce;
end;
$$;

-- ─────────────────────────────────────────────────────── 승인 취소 (R2-16 보상)
create or replace function public.revoke_approval(p_item_id uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_item review_items%rowtype;
  v_industry text;
  v_date date;
  v_dummy int;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into strict v_item from review_items where id = p_item_id for update;
  if v_item.status <> 'approved' then
    raise exception 'not_approved' using errcode = '55000';
  end if;

  -- ❗ 승인 시점에 고정해 둔 카운터 좌표를 쓴다.
  --    현재 업종·current_date 로 다시 계산하면, 업체 업종이 바뀌었거나 세션 시간대가
  --    다를 때 엉뚱한 카운터를 감소시킨다.
  select approval_date, approved_industry into strict v_date, v_industry
    from leads where review_item_id = p_item_id;

  -- ❗ 잠금 순서를 decide_review_item 과 **동일하게** 맞춘다: 일 총량 → 업종 → leads.
  --    (이전 구현은 leads 를 먼저 지우고 카운터를 잠가서, 승인 쪽의
  --     "카운터 잠금 → leads 삽입" 과 순환 대기가 생길 수 있었다.)
  select approved_total into v_dummy from approval_day_totals
    where approval_date = v_date for update;
  select approved_count into v_dummy from approval_counters
    where approval_date = v_date and industry = v_industry for update;

  delete from leads where review_item_id = p_item_id;

  update approval_day_totals set approved_total = greatest(approved_total - 1, 0)
    where approval_date = v_date;
  update approval_counters set approved_count = greatest(approved_count - 1, 0)
    where approval_date = v_date and industry = v_industry;

  update review_items
    set status = 'rejected', reject_reason = p_reason,
        decided_by = auth.uid(), decided_at = now()
    where id = p_item_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'review.revoke', 'review_items', p_item_id::text,
          jsonb_build_object('reason', p_reason));

  return jsonb_build_object('ok', true);
end;
$$;

-- ─────────────────────────────────────────────────────── 접촉 근거 설정
create or replace function public.set_contact_basis(
  p_lead_id uuid, p_basis contact_basis, p_note text default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update leads
    set contact_legal_basis = p_basis,
        contact_basis_set_by = auth.uid(),
        contact_basis_note = p_note
    where id = p_lead_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'lead.set_contact_basis', 'leads', p_lead_id::text,
          jsonb_build_object('basis', p_basis, 'note', p_note));

  return jsonb_build_object('ok', true);
end;
$$;

-- ─────────────────────────────────────────────────────── export (R2-03)
--
-- "접촉 근거 없는 리드는 export 제외" 는 문장으로만 있으면 통제가 아니다.
-- export 경로를 이 함수 하나로 좁히고 조건을 SQL 로 강제한다.
create or replace function public.export_leads(p_from date, p_to date)
returns setof jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_watermark jsonb;
  v_max_exports int;
  v_emitted int := 0;
  v_skipped_capped int := 0;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_max_exports := coalesce((select (value #>> '{export,max_per_lead}')::int
                             from settings where key = 'export'), 3);

  v_watermark := jsonb_build_object(
    'exported_by', auth.uid(),
    'exported_at', now(),
    'range', jsonb_build_array(p_from, p_to)
  );

  -- 상한에 걸려 제외되는 리드 수를 미리 센다.
  -- 조용히 빼면 "왜 건수가 줄었는지" 를 알 수 없으므로 감사 로그에 남긴다.
  select count(*) into v_skipped_capped
    from leads l
    where l.created_at::date between p_from and p_to
      and l.export_count >= v_max_exports;

  for v_row in
    select l.id, l.score, l.contact_legal_basis,
           c.name as company_name, c.industry, c.region_sido, c.region_sigungu,
           e.address as email
    from leads l
    join companies c on c.id = l.company_id
    join emails e on e.id = l.email_id
    where l.created_at::date between p_from and p_to
      -- ❗ 상한에 도달한 리드는 후보에서 제외한다.
      --    루프 안에서 예외를 던지면 앞서 처리한 갱신까지 전부 롤백되어,
      --    상한에 걸린 리드 하나가 export 범위 전체를 영구히 막는다.
      and l.export_count < v_max_exports
      -- ❗ 접촉 근거 하드 게이트
      and l.contact_legal_basis in
          ('explicit_consent', 'existing_transaction_6m', 'legitimate_interest_claimed')
      and l.use_scope = 'internal_only'
      and c.do_not_contact = false
      and c.opt_out_at is null
      and l.retention_until >= current_date
      and e.mx_ok is true
      and not exists (
        select 1 from privacy_requests pr
        where pr.company_id = l.company_id
          and pr.status in ('received', 'in_progress', 'on_hold')
      )
    order by l.score desc
  loop
    -- ❗ 검사와 증가를 한 문장으로 합친다. 나눠 두면 두 export 가 같은 값을 읽고
    --    둘 다 통과한 뒤 각자 +1 해서 상한을 넘긴다.
    update leads
      set export_status = 'exported',
          exported_at = now(),
          export_count = export_count + 1
      where id = v_row.id and export_count < v_max_exports;

    -- 경쟁에서 밀려 상한에 도달했으면 그 행만 건너뛴다 (전체를 실패시키지 않는다).
    if not found then
      continue;
    end if;

    v_emitted := v_emitted + 1;
    return next to_jsonb(v_row) || jsonb_build_object('_watermark', v_watermark);
  end loop;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'leads.export', 'leads', null,
          v_watermark || jsonb_build_object('count', v_emitted, 'skipped_capped', v_skipped_capped));
end;
$$;

-- ─────────────────────────────────────────────────────── 설정 변경
create or replace function public.update_setting(p_key text, p_value jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_before jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select value into v_before from settings where key = p_key;

  insert into settings (key, value, updated_by, updated_at)
  values (p_key, p_value, auth.uid(), now())
  on conflict (key) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'settings.update', 'settings', p_key, v_before, p_value);

  return jsonb_build_object('ok', true);
end;
$$;

-- ─────────────────────────────────────────────────────── 실행 스냅샷
-- 실행 시작 시 설정을 동결한다. 이후 설정이 바뀌어도 진행 중인 run 은 영향받지 않는다.
create or replace function public.snapshot_settings() returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from settings;
$$;

-- ─────────────────────────────────────────────────────── 잡 큐 (F-15 · R2-24)
--
-- ❗ fencing 은 **DB 안에서** 강제한다.
--    스키마에 `fence_token` 컬럼만 두고 증가·검증을 애플리케이션에 맡기면,
--    워커가 jobs 를 자유롭게 UPDATE 할 수 있는 한 좀비 워커의 늦은 쓰기를 막지 못한다.
--    획득·heartbeat·완료를 RPC 로 좁히고, 워커에게서 jobs UPDATE 권한을 회수한다.

/** 잡 하나를 원자적으로 획득한다. fence_token 을 증가시켜 이전 소유자를 무효화한다. */
create or replace function public.acquire_job(p_worker text, p_lease_seconds int default 120)
returns table (job_id bigint, fence_token bigint, stage text, payload jsonb)
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_lease_seconds <= 0 or p_lease_seconds > 3600 then
    raise exception 'invalid_lease' using errcode = '22023';
  end if;

  return query
  update jobs j set
    status = 'running',
    locked_by = p_worker,
    locked_at = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    heartbeat_at = now(),
    -- 획득할 때마다 증가 → 이전 소유자의 토큰은 즉시 무효가 된다.
    fence_token = j.fence_token + 1,
    -- 크래시로 결과를 남기지 못한 시도도 세어야 무한 재시도를 막는다.
    attempts = j.attempts + 1
  where j.id = (
    select id from jobs
    where status = 'queued' and run_after <= now()
    order by id
    for update skip locked
    limit 1
  )
  returning j.id, j.fence_token, j.stage, j.payload;
end;
$$;

/** lease 연장. 자기 토큰이 아니면 0행을 돌려주고, 워커는 즉시 작업을 중단해야 한다. */
create or replace function public.heartbeat_job(
  p_job_id bigint, p_fence_token bigint, p_worker text, p_lease_seconds int default 120
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  update jobs set heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    where id = p_job_id and fence_token = p_fence_token and locked_by = p_worker and status = 'running';
  return found;
end;
$$;

/** 결과 커밋. 토큰이 맞지 않으면 아무것도 하지 않는다 (좀비 워커의 늦은 쓰기 차단). */
create or replace function public.complete_job(
  p_job_id bigint, p_fence_token bigint, p_worker text, p_success boolean, p_error text default null
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  update jobs set
    status = case
      when p_success then 'succeeded'::job_status
      when attempts >= max_attempts then 'dead'::job_status
      else 'queued'::job_status
    end,
    run_after = case
      when p_success or attempts >= max_attempts then run_after
      else now() + least(power(2, attempts) * interval '2 seconds', interval '5 minutes')
                 + (random() * interval '5 seconds')
    end,
    locked_by = null, locked_at = null, lease_expires_at = null, heartbeat_at = null,
    last_error = p_error
  where id = p_job_id and fence_token = p_fence_token and locked_by = p_worker and status = 'running';
  return found;
end;
$$;

-- reaper: 만료된 lease 를 회수한다. 시도 횟수를 소진했으면 재큐잉하지 않고 dead 로 보낸다.
create or replace function public.reap_expired_jobs() returns int
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count int;
begin
  update jobs set
    status = case when attempts >= max_attempts then 'dead'::job_status else 'queued'::job_status end,
    run_after = case
      when attempts >= max_attempts then run_after
      else now() + least(power(2, attempts) * interval '2 seconds', interval '5 minutes')
                 + (random() * interval '5 seconds')
    end,
    locked_by = null, locked_at = null, lease_expires_at = null, heartbeat_at = null,
    last_error = coalesce(last_error, 'lease_expired')
  where status = 'running' and lease_expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────── 운영 관리 RPC
--
-- ❗ 최초 admin 부트스트랩은 DB 소유자가 직접 한다 (배포 runbook 항목):
--      update public.profiles set role = 'admin' where email = '<운영자 이메일>';
--    admin 이 하나도 없으면 아래 함수들은 아무도 호출할 수 없다. 이는 의도된 것이다 —
--    권한 승격 경로를 애플리케이션에 두면 그 경로 자체가 공격면이 된다.

create or replace function public.set_profile_role(p_user_id uuid, p_role user_role)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_before user_role;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 마지막 admin 이 스스로를 강등해 잠기는 것을 막는다.
  if p_role <> 'admin' and p_user_id = auth.uid() then
    if (select count(*) from profiles where role = 'admin') <= 1 then
      raise exception 'last_admin' using errcode = '55000';
    end if;
  end if;

  select role into v_before from profiles where id = p_user_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  update profiles set role = p_role where id = p_user_id;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'profile.set_role', 'profiles', p_user_id::text,
          to_jsonb(v_before), to_jsonb(p_role));
  return jsonb_build_object('ok', true);
end;
$$;

/**
 * 데이터 소스 승인 상태 변경.
 *
 * 네이버 약관 문제가 확인되면 이 함수로 `approved=false` 로 되돌리면 되고,
 * 그 즉시 ORS 어댑터가 부팅을 거부해 축소 파이프라인으로 폴백된다 (D-002).
 */
create or replace function public.update_source_registry(
  p_source text, p_approved boolean, p_written_approval_ref text default null, p_note text default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_before jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select to_jsonb(s) into v_before from source_registry s where source = p_source;
  if v_before is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  update source_registry
    set approved = p_approved,
        written_approval_ref = coalesce(p_written_approval_ref, written_approval_ref),
        note = coalesce(p_note, note),
        reviewed_by = auth.uid()::text,
        reviewed_at = current_date
    where source = p_source;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'source_registry.update', 'source_registry', p_source,
          v_before, jsonb_build_object('approved', p_approved, 'ref', p_written_approval_ref));
  return jsonb_build_object('ok', true);
end;
$$;

-- ─────────────────────────────────────────────────────── 데이터 정리 (R2-13)
create or replace function public.cleanup_old_data() returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_hits int; v_aggs int; v_obs int; v_cache int; v_audit int;
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

  delete from review_view_nonces where expires_at < now();

  return jsonb_build_object(
    'search_hits', v_hits, 'search_aggregates', v_aggs,
    'company_observations', v_obs, 'http_cache', v_cache, 'audit_log', v_audit
  );
end;
$$;
