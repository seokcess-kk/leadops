-- ─────────────────────────────────────────────────────────────────────────────
-- 로컬·테스트 전용 부트스트랩
--
-- Supabase 는 `anon` / `authenticated` / `service_role` 역할과 `auth` 스키마,
-- `auth.uid()` 를 이미 제공한다. 이 파일은 **로컬 Postgres 에서만** 그 환경을 흉내 낸다.
--
-- ❗ 마이그레이션 러너는 `bootstrap: true` 일 때만 이 파일을 적용한다.
--    Supabase 에 적용하면 그쪽 auth 구현을 덮어쓸 수 있으므로 절대 올리지 않는다.
-- ─────────────────────────────────────────────────────────────────────────────

do $bootstrap$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  -- 워커 전용 최소권한 역할 (설계서 F-14). Supabase 에서도 직접 만들어야 한다.
  if not exists (select 1 from pg_roles where rolname = 'leadops_worker') then
    create role leadops_worker nologin noinherit;
  end if;
end
$bootstrap$;

create schema if not exists auth;

-- Supabase 의 auth.users 를 흉내 낸 최소 스텁.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Supabase 의 auth.uid() 와 같은 방식: 요청 JWT 의 sub 클레임을 읽는다.
-- 테스트에서는 set_config('request.jwt.claim.sub', '<uuid>', true) 로 흉내 낸다.
create or replace function auth.uid() returns uuid
language sql stable
as $uid$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$uid$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
