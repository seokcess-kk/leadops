-- 연락처 이메일 DNS·MX 검증 결과 기록 (Phase 6)
--
-- `enter_contact_email` 은 문법만 본다. DNS·MX 는 네트워크 조회가 필요하므로 DB 안에서
-- 할 수 없고, 그 결과를 누가 쓸 수 있는지가 **승인 게이트의 강도**를 결정한다.
--
-- ❗ 이 함수를 `authenticated` 에게 주면 안 된다. Supabase 모델에서 authenticated 는
--    브라우저에서 RPC 를 직접 호출할 수 있으므로, 검수자가
--    `verify_contact_email(id, true, true)` 를 스스로 불러 **MX 게이트를 우회**할 수 있다.
--    그러면 `decide_review_item` 의 `mx_ok is true` 조건이 아무 의미가 없어진다.
--
--    따라서 실행권은 **서버 측 역할에만** 준다. API 서버가 직접 DNS 를 조회한 뒤
--    그 결과로 이 함수를 호출한다. 사용자 JWT 컨텍스트로는 호출되지 않는다.
--
-- SMTP 접속은 하지 않는다 (설계서 1.6: SMTP 검증 제외). MX 레코드 존재까지만 본다.

create or replace function public.verify_contact_email(
  p_email_id uuid,
  p_dns_ok boolean,
  p_mx_ok boolean,
  p_mx_hosts text[] default null,
  p_confidence numeric default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_email emails%rowtype;
begin
  select * into strict v_email from emails where id = p_email_id;

  -- 되돌리는 것도 정당한 결과다 (도메인 만료·MX 삭제). 다만 감사 로그에 남긴다.
  v_before := jsonb_build_object('dns_ok', v_email.dns_ok, 'mx_ok', v_email.mx_ok);

  update emails
     set dns_ok      = p_dns_ok,
         mx_ok       = p_mx_ok,
         mx_hosts    = p_mx_hosts,
         confidence  = p_confidence,
         verified_at = now()
   where id = p_email_id;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'email.verify', 'emails', p_email_id::text, v_before,
          jsonb_build_object('dns_ok', p_dns_ok, 'mx_ok', p_mx_ok,
                             'mx_hosts', to_jsonb(coalesce(p_mx_hosts, '{}'::text[]))));

  return jsonb_build_object('ok', true, 'email_id', p_email_id, 'mx_ok', p_mx_ok);
end;
$$;

-- ❗ 실행권을 좁힌다. authenticated 는 절대 포함하지 않는다.
revoke all on function public.verify_contact_email(uuid, boolean, boolean, text[], numeric)
  from public, anon, authenticated;
grant execute on function public.verify_contact_email(uuid, boolean, boolean, text[], numeric)
  to service_role;

comment on function public.verify_contact_email(uuid, boolean, boolean, text[], numeric) is
  '서버 전용. authenticated 에게 주면 검수자가 MX 게이트를 스스로 통과시킬 수 있다.';
