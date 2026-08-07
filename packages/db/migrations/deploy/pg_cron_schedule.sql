-- ═══════════════════════════════════════════════════════════════════════════
-- 배포 전용 — pg_cron 스케줄 등록 (설계서 5.1 · 7.1)
--
-- ❗ **마이그레이션 체인에 넣지 않는다.** `pg_cron` 은 `shared_preload_libraries` 가
--    필요한 확장이고, 로컬 검증 컨테이너(`postgres:17-alpine`)에는 없다. 검증하지 못한
--    SQL 을 체인에 넣으면 배포에서 처음 실행된다 — 이 저장소가 `0000_local_bootstrap` 을
--    Supabase 에 적용하지 않는 것과 같은 이유다.
--
-- ❗ 적용 대상: Supabase(또는 pg_cron·pg_net 이 있는 자체 호스팅 Postgres).
--    적용 전 `docs/07-runbook.md` 의 체크리스트를 확인한다.
--
-- 적용:
--   psql "$SUPABASE_DB_URL" -v api_base="'https://api.example.kr'" \
--        -v trigger_secret="'<INTERNAL_TRIGGER_SECRET 과 같은 값>'" \
--        -f packages/db/migrations/deploy/pg_cron_schedule.sql
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 비밀 보관 ───────────────────────────────────────────────────────────────
--
-- ❗ 서명 비밀을 cron 명령 문자열에 그대로 박으면 `cron.job` 을 읽을 수 있는 누구에게나
--    노출된다. 별도 테이블에 넣고 접근을 소유자로 제한한다.
create table if not exists private_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on table private_config from public, anon, authenticated;

insert into private_config (key, value) values
  ('api_base', :api_base),
  ('trigger_secret', :trigger_secret)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- ── 트리거 호출 함수 ────────────────────────────────────────────────────────
--
-- ❗ 서명 규칙은 `apps/api/src/hmac.ts` 와 **같아야 한다**: `sha256(secret, "<ts>.<body>")`.
--    한쪽만 바꾸면 매일 06:00 에 401 이 나고, 그 사실은 다음날 리드가 0 건일 때 알게 된다.
create or replace function private_trigger_run()
returns bigint
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_base text;
  v_secret text;
  v_ts bigint := floor(extract(epoch from now()))::bigint;
  v_body text;
  v_sig text;
  v_request_id bigint;
begin
  select value into strict v_base from private_config where key = 'api_base';
  select value into strict v_secret from private_config where key = 'trigger_secret';
  -- 스케줄 실행의 요청 본문. 없으면 '{}' = 전체 업종.
  -- ❗ 미검증 소스가 막혀 있는 동안 업종을 좁히는 데 쓴다 — 예:
  --    {"industries":["derm","plastic","dental"]} (공정위 요청주소 확보 전까지 franchise 제외.
  --    비워 두면 franchise collect 가 매일 dead 가 되어 실행이 partial 로 끝난다).
  -- ❗ **서명 전에 jsonb 로 정규화한다.** pg_net 은 body 를 jsonb 로 직렬화해 보내는데
  --    (콜론·쉼표 뒤 공백), 원문 위에 서명하면 전송 바이트와 달라져 bad_signature 가
  --    난다 — 2026-08-07 스테이징 왕복 검증에서 실증. 정규화 후 서명하면 재직렬화가
  --    멱등이라 서명한 바이트가 그대로 전송된다.
  select coalesce(
    (select value from private_config where key = 'run_body'), '{}'
  )::jsonb::text into v_body;

  v_sig := 'sha256=' || encode(
    extensions.hmac(v_ts::text || '.' || v_body, v_secret, 'sha256'), 'hex'
  );

  select net.http_post(
    url := v_base || '/internal/run',
    body := v_body::jsonb,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-leadops-timestamp', v_ts::text,
      'x-leadops-signature', v_sig
    ),
    timeout_milliseconds := 15000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function private_trigger_run() from public, anon, authenticated;

-- ── 스케줄 ──────────────────────────────────────────────────────────────────
--
-- ❗ pg_cron 은 **UTC** 로 돈다. KST 06:00 = UTC 21:00 (전일). 요일도 하루 밀리므로
--    `0-4`(일~목 UTC) = 월~금 KST 다. 평일 판정을 cron 표현식에만 맡기지 않고
--    `should_start_scheduled_run()` 이 KST 기준으로 다시 확인한다 — 서머타임이 없는
--    한국이라 지금은 같지만, 판정 근거가 두 곳에 있으면 한쪽만 바꾸는 실수가 생긴다.
select cron.unschedule('leadops-daily-run') where exists (
  select 1 from cron.job where jobname = 'leadops-daily-run'
);
select cron.schedule('leadops-daily-run', '0 21 * * 0-4', 'select private_trigger_run()');

-- reaper — 만료된 lease 회수. 1분마다 (설계서 7.1).
select cron.unschedule('leadops-reap') where exists (
  select 1 from cron.job where jobname = 'leadops-reap'
);
select cron.schedule('leadops-reap', '* * * * *', 'select public.reap_expired_jobs()');

-- 정리 잡 — 용량 인식. 매일 KST 04:00 (UTC 19:00), 실행 2시간 전.
select cron.unschedule('leadops-cleanup') where exists (
  select 1 from cron.job where jobname = 'leadops-cleanup'
);
select cron.schedule('leadops-cleanup', '0 19 * * *', 'select public.cleanup_by_capacity()');

-- 확인
select jobname, schedule, active from cron.job where jobname like 'leadops-%' order by jobname;
