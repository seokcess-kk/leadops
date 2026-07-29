-- 확장과 열거형 (설계서 6.2)
-- R2-34: extensions 스키마를 먼저 만들고, 컬럼은 extensions.citext 로 완전 수식한다.

create schema if not exists extensions;
create extension if not exists citext with schema extensions;

grant usage on schema extensions to anon, authenticated, service_role, leadops_worker;

-- ── 권한 ──
create type user_role as enum ('admin', 'user');

-- ── 실행 ──
create type run_status as enum ('queued', 'running', 'paused', 'succeeded', 'partial', 'failed', 'cancelled');
create type stage_status as enum ('pending', 'running', 'succeeded', 'partial', 'failed', 'skipped');
create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');

-- ── 업체 ──
create type company_status as enum ('active', 'suspended', 'closed', 'unknown');
create type official_status as enum ('confirmed', 'likely', 'uncertain', 'not_official', 'unavailable');

-- ── 이메일 (설계서 결론 A) ──
create type email_type as enum
  ('representative', 'inquiry', 'partnership', 'marketing', 'business_info', 'staff', 'unknown');

-- ❗ 'scraped' 값은 존재하지 않는다. 홈페이지에서 프로그램으로 이메일을 수집하지 않기 때문이다
--    (정보통신망법 제50조의2). 타입 자체가 그 결정을 강제한다.
create type acquisition_method as enum ('manual_entry', 'public_api');

-- R2-03: 수집 근거와 접촉 근거를 분리한다.
create type collection_basis as enum
  ('public_api_field', 'manual_from_public_site', 'provided_by_subject');
create type contact_basis as enum
  ('pending_legal_review', 'explicit_consent', 'existing_transaction_6m',
   'legitimate_interest_claimed', 'not_permitted');

-- ── 검색·채널 ──
create type channel_type as enum
  ('official_site', 'official_blog', 'official_video', 'official_sns', 'place', 'news',
   'thirdparty_blog', 'cafe', 'community', 'review', 'webdoc', 'unknown');
create type recency_bucket as enum ('d0_60', 'd61_120', 'd120_plus', 'unknown');

-- ── 검수 ──
create type review_status as enum ('pending', 'approved', 'rejected');
