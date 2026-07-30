-- ═══════════════════════════════════════════════════════════════════════════
-- 결함 수정 — `settings` 단일 행에 중첩 jsonb 경로를 쓴 곳
--
-- `settings` 는 **키 하나에 그 키의 객체만** 담는다:
--     key='review'  value={"nonce_ttl_minutes": 30, "manual_email_per_minute": 3}
--
-- 그런데 세 함수가 `value #>> '{review,nonce_ttl_minutes}'` 처럼 **키를 한 번 더** 타고
-- 들어갔다. 그 경로는 항상 NULL 이고, 전부 `coalesce(..., 기본값)` 으로 감싸져 있어서
-- **조용히 기본값으로 동작**했다 — 설정을 바꿔도 아무 일이 일어나지 않는다.
--
-- 왜 아무도 몰랐는가: 시드 값이 코드의 기본값과 같아서(30 · 3 · 3) 테스트도 통과했다.
-- 이 저장소가 경계하는 실패 모드 그대로다 — "운영자는 값을 바꿨다고 믿는다"(0004 주석).
--
-- 영향:
--   review.manual_email_per_minute  이메일 수동 입력 **rate limit** 을 조일 수 없었다 (보안 통제)
--   review.nonce_ttl_minutes        검수 화면 nonce 유효 시간을 바꿀 수 없었다
--   export.max_per_lead             리드당 export 횟수 상한을 바꿀 수 없었다 (항상 3)
--
-- ❗ `runs.settings_snapshot` 을 읽는 곳(`decide_review_item`)은 **정상**이다.
--    스냅샷은 `snapshot_settings()` 가 키로 묶은 객체라 `{targets,final_max}` 가 맞다.
--    같은 문법이 대상에 따라 다르게 동작하는 것이 이 결함의 원인이므로, 아래 헬퍼로
--    "단일 행에서 읽는다" 는 의도를 이름에 남긴다.
-- ═══════════════════════════════════════════════════════════════════════════

-- 단일 설정 행에서 정수 하나를 읽는다. 없으면 NULL (호출자가 기본값을 정한다).
--
-- ❗ 형식이 어긋나면 NULL 이 아니라 **에러**다. 조용히 기본값으로 되돌리면 지금과 똑같은
--    결함이 다시 생긴다 — 설정을 바꿨는데 반영되지 않은 상태를 만들지 않는다.
create or replace function public.setting_int(p_key text, p_field text)
returns int
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_raw text;
begin
  select value #>> array[p_field] into v_raw from settings where key = p_key;
  if v_raw is null then
    return null;
  end if;
  if v_raw !~ '^-?\d+$' then
    raise exception 'configuration_error' using errcode = '22023',
      detail = format('settings.%s.%s 가 정수가 아닙니다: %s', p_key, p_field, v_raw);
  end if;
  return v_raw::int;
end;
$$;

revoke all on function public.setting_int(text, text) from public, anon;
grant execute on function public.setting_int(text, text) to authenticated, leadops_worker;

-- ─────────────────────────────────────────────────────── (1) 용량 상한
-- 0012 에서 같은 실수를 했다. 여기서 바로잡는다.
create or replace function public.db_capacity(p_limit_bytes bigint default null)
returns jsonb
language plpgsql security definer
-- ❗ `pg_catalog` 를 적지 않는다 — 항상 암시적으로 먼저 검색되고, 스키마 린트는
--    `search_path=public, pg_temp` 만 허용한다.
set search_path = public, pg_temp
as $$
declare
  v_bytes bigint;
  v_limit bigint;
  v_pct numeric;
  v_raw text;
begin
  v_bytes := pg_database_size(current_database());

  if p_limit_bytes is not null then
    v_limit := p_limit_bytes;
  else
    select value #>> array['limit_bytes'] into v_raw from settings where key = 'capacity';
    if v_raw is not null and v_raw !~ '^\d+$' then
      raise exception 'configuration_error' using errcode = '22023',
        detail = format('settings.capacity.limit_bytes 가 정수가 아닙니다: %s', v_raw);
    end if;
    -- Supabase Free 500MB. self-host 로 옮기면 설정으로 올린다.
    v_limit := coalesce(v_raw::bigint, 524288000);
  end if;

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

revoke all on function public.db_capacity(bigint) from public, anon;
grant execute on function public.db_capacity(bigint) to leadops_worker;

-- ─────────────────────────────────────────────────────── (2) export 횟수 상한
--
-- 0004 의 본문을 그대로 옮기고 **경로 한 곳만** 고쳤다.
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

  -- 결함 수정: '{export,max_per_lead}' → '{max_per_lead}'
  v_max_exports := coalesce(public.setting_int('export', 'max_per_lead'), 3);
  if v_max_exports <= 0 then
    raise exception 'configuration_error' using errcode = '22023',
      detail = 'export.max_per_lead 가 0 이하입니다';
  end if;

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

revoke all on function public.export_leads(date, date) from public, anon;
grant execute on function public.export_leads(date, date) to authenticated;

-- ─────────────────────────────────────────────────────── (3) nonce 유효 시간
create or replace function public.issue_review_nonce(p_review_item_id uuid)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_nonce text; v_ttl int;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  perform 1 from review_items where id = p_review_item_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- 결함 수정: '{review,nonce_ttl_minutes}' → '{nonce_ttl_minutes}'
  v_ttl := coalesce(public.setting_int('review', 'nonce_ttl_minutes'), 30);
  if v_ttl <= 0 then
    raise exception 'configuration_error' using errcode = '22023',
      detail = 'review.nonce_ttl_minutes 가 0 이하입니다';
  end if;

  -- gen_random_uuid() 는 PG13+ 내장이고 암호학적으로 안전한 난수를 쓴다.
  -- pgcrypto 확장을 요구하지 않기 위해 두 개를 이어 붙여 244비트 엔트로피를 만든다.
  v_nonce := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into review_view_nonces (nonce, review_item_id, user_id, expires_at)
  values (v_nonce, p_review_item_id, auth.uid(), now() + make_interval(mins => v_ttl));
  return v_nonce;
end;
$$;

revoke all on function public.issue_review_nonce(uuid) from public, anon;
grant execute on function public.issue_review_nonce(uuid) to authenticated;

-- ─────────────────────────────────────────────────────── (4) 수동 입력 rate limit
--
-- ❗ 이것은 **보안 통제**다. 운영자가 조일 수 없는 rate limit 은 rate limit 이 아니다.
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

  -- 결함 수정: '{review,manual_email_per_minute}' → '{manual_email_per_minute}'
  v_rate_limit := coalesce(public.setting_int('review', 'manual_email_per_minute'), 3);
  if v_rate_limit <= 0 then
    raise exception 'configuration_error' using errcode = '22023',
      detail = 'review.manual_email_per_minute 가 0 이하입니다';
  end if;

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

revoke all on function public.enter_contact_email(uuid, text, email_type, uuid, text) from public, anon;
grant execute on function public.enter_contact_email(uuid, text, email_type, uuid, text) to authenticated;
