# 운영 런북 (Phase 7)

배포·스케줄러·개인정보 처리·용량·백업. 설계서 `00-plan.md` 5.1 · 7.1 · 4.2 기준.

> 이 문서는 **손으로 하는 일**을 적는다. 코드가 강제하는 것은 코드에 있고, 여기에는
> 코드가 강제할 수 없는 절차(키 발급·법적 판단·복구 결정)만 남긴다.

---

## 1. 최초 배포

### 1.1 DB 마이그레이션

```bash
# Supabase — ❗ --bootstrap 을 쓰지 않는다. auth 스키마와 anon·authenticated·service_role 은
# Supabase 가 제공하고, 우리 전용 역할 leadops_worker 는 0001 이 없으면 만든다 (멱등).
DATABASE_URL="$SUPABASE_DB_URL" pnpm db:migrate

# 자체 호스팅 — 역할·auth 스텁을 직접 만든다
DATABASE_URL="$DB_URL" pnpm db:migrate --bootstrap
```

### 1.2 최초 admin 승격

권한 승격 경로를 애플리케이션에 두면 그 경로 자체가 공격면이 되므로 RPC 로 만들지 않았다.
DB 소유자가 직접 한다.

```sql
update public.profiles set role = 'admin' where email = '<운영자 이메일>';
```

이후 역할 변경은 `set_profile_role` RPC(admin 전용)로 한다.

### 1.3 환경변수

| 변수 | 어디서 쓰나 | 없으면 |
|---|---|---|
| `API_DATABASE_URL` | 검수 API | 부팅 실패 |
| `SUPABASE_JWT_SECRET` | 검수 API · taimen 프록시 | 부팅 실패 / 401 |
| `INTERNAL_TRIGGER_SECRET` | `POST /internal/run` 서명 (**32자 이상**) | 그 경로가 401 (스케줄 비활성) |
| `WORKER_DATABASE_URL` | 워커 (`leadops_worker` 역할) | 부팅 실패 |
| `LEADOPS_API_URL` | taimen → API | `127.0.0.1:8792` 로 가정 |
| `SUPABASE_URL` · `SUPABASE_ANON_KEY` | taimen 서버 (Supabase Auth 로그인·세션) | Supabase 로그인 경로 비활성 — dev login 또는 401 |
| `SUPABASE_JWT_PUBLIC_JWK` | 검수 API — Supabase 사용자 토큰(ES256) 공개키. `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` 의 키 JSON 한 줄 | ES256 토큰 전부 401 (Supabase 실로그인 불가 — dev HS256 경로만 동작) |

> ❗ `INTERNAL_TRIGGER_SECRET` 은 pg_cron 쪽 `private_config.trigger_secret` 과 **같은 값**이어야
> 한다. 한쪽만 바꾸면 매일 06:00 에 401 이 나고, 그 사실은 **다음날 리드가 0 건일 때** 알게 된다.
> 바꿀 때는 두 곳을 같은 배포에서 바꾼다.

---

## 2. 스케줄러

### 2.1 구조

```
pg_cron (UTC 21:00 = KST 06:00, 일~목 UTC = 월~금 KST)
  └─ private_trigger_run()          비밀을 읽어 HMAC 서명
       └─ pg_net.http_post → POST /internal/run
            ├─ verifyInternalSignature()          서명·재생 검증 (apps/api/src/hmac.ts)
            ├─ should_start_scheduled_run()       평일·중복·용량 판정 (DB)
            └─ startRun(trigger='cron')           실행 생성
```

**판정은 cron 표현식에 없다.** cron 은 "부를 시각" 만 알고, 평일·중복·용량은
`should_start_scheduled_run()` 이 KST 기준으로 판정한다. 주말에 불려도 200 + `skipped` 로
답한다 — 실패가 아니므로 알림을 울릴 이유가 없다.

### 2.2 등록

```bash
psql "$SUPABASE_DB_URL" \
  -v api_base="'https://api.example.kr'" \
  -v trigger_secret="'<INTERNAL_TRIGGER_SECRET 과 같은 값>'" \
  -f packages/db/migrations/deploy/pg_cron_schedule.sql
```

> ❗ 이 스크립트는 **마이그레이션 체인에 없다.** `pg_cron` 은 `shared_preload_libraries` 가
> 필요하고 로컬 검증 컨테이너(`postgres:17-alpine`)에는 없다. 검증하지 못한 SQL 을 체인에
> 넣으면 배포에서 처음 실행된다.

**스케줄 실행의 업종 제한** — `private_config.run_body` 가 `/internal/run` 의 요청 본문이
된다 (없으면 `{}` = 전체 업종). **미검증 소스가 막혀 있는 동안은 반드시 좁힌다** —
비워 두면 franchise `collect` 가 매일 dead 가 되어 실행이 `partial` 로 끝나고,
"3영업일 연속 성공" 을 영영 못 넘는다 (2026-08-07 스모크에서 실증).

```sql
insert into private_config (key, value)
values ('run_body', '{"industries":["derm","plastic","dental"]}')
on conflict (key) do update set value = excluded.value, updated_at = now();
-- 공정위 요청주소 확보·FTC 검증 후 이 행을 지우면 전체 업종으로 돌아간다
```

등록되는 잡:

| 잡 | 스케줄 (UTC) | KST | 하는 일 |
|---|---|---|---|
| `leadops-daily-run` | `0 21 * * 0-4` | 평일 06:00 | 실행 트리거 |
| `leadops-reap` | `* * * * *` | 1분마다 | 만료 lease 회수 |
| `leadops-cleanup` | `0 19 * * *` | 매일 04:00 | 용량 인식 정리 |

### 2.3 확인

```sql
-- 스케줄 등록 상태
select jobname, schedule, active from cron.job where jobname like 'leadops-%';

-- 최근 실행 결과 (pg_cron 자체 기록)
select jobname, status, return_message, start_time
  from cron.job_run_details
 where jobname like 'leadops-%'
 order by start_time desc limit 20;

-- 판정 결과를 직접 본다 (실행을 만들지 않는다)
select jsonb_pretty(public.should_start_scheduled_run());
```

로컬·수동으로는 같은 판정 함수를 쓰는 CLI 가 있다:

```bash
pnpm worker schedule --dry-run    # 판정만
pnpm worker schedule              # 조건 충족 시 cron 실행 생성
```

### 2.4 06:00 에 실행이 안 만들어졌을 때

순서대로 좁힌다.

1. `cron.job_run_details` 에 기록이 있나 → 없으면 pg_cron 자체가 안 돌았다 (확장·재시작 확인)
2. 기록이 있는데 실패 → `return_message` 확인. `pg_net` 응답은
   `select * from net._http_response order by created desc limit 5` 로 본다
3. HTTP 401 `bad_signature` → 비밀 불일치. `private_config.trigger_secret` 과
   `INTERNAL_TRIGGER_SECRET` 을 대조한다
4. HTTP 401 `stale_signature` → DB 와 API 서버의 시계 차가 5분을 넘었다 (NTP 확인)
5. HTTP 200 인데 `skipped` → `decision.reasons` 를 읽는다
   (`schedule_disabled` · `not_a_weekday` · `already_ran_today` · `capacity_blocked`)
6. HTTP 503 `capacity_exceeded` → 3절로

> ⚠️ **Phase 7 완료 기준 중 "평일 06:00 3영업일 연속 성공" 은 달력이 필요하다.**
> 배포 후 3영업일 동안 위 쿼리로 확인하고 결과를 이 문서에 기록한다. 코드로 대체할 수 없다.

---

## 3. 용량 (설계서 4.2)

정상상태로 180일이면 약 620MB — **Supabase Free 500MB 를 넘긴다.** 넘긴 뒤에 알면 늦다.

| 레벨 | 임계 | 동작 |
|---|---|---|
| `ok` | < 70% | 평시 |
| `warn` | ≥ 70% | 알람. 보존기간·이전 계획 점검 |
| `cleanup` | ≥ 85% | 정리 잡이 보존기간을 줄인다 (관련 문서 30→7일, 집계·관측 365→120일) |
| `block` | ≥ 90% | **신규 실행 차단** (`startRun` 이 `capacity_exceeded` 로 실패) |

```bash
pnpm worker capacity     # 레벨이 block 이면 종료 코드 1 — 모니터링이 이걸 본다
pnpm worker cleanup      # 용량 인식 정리
```

```sql
select jsonb_pretty(public.capacity_report());   -- 테이블별 크기 (admin)
```

화면: `/privacy` 와 같은 admin 영역에서 `GET /api/capacity` 로 본다.

### 3.1 90% 도달 대응

1. `pnpm worker cleanup` — 보존기간 정리
2. 그래도 줄지 않으면 `capacity_report()` 로 무엇이 먹는지 본다
3. 상한을 올린다 (self-host 이전 후):
   ```sql
   select public.update_setting('capacity', '{"limit_bytes": 5368709120, "warn_pct": 70, "cleanup_pct": 85, "block_pct": 90}'::jsonb);
   ```
4. **180일 시점의 self-host 이전은 기정사실이다** (설계서 4.2). Supabase Pro($25/월)로
   가면 예산의 절반이 사라지므로 워커 VPS 위 Postgres 로 옮긴다.

파티션 유지는 `maintain_observation_partitions()` 가 한다 — `cleanup_by_capacity()`(워커
cleanup·pg_cron)와 `startRun` 양쪽에서 불린다. +2개월 선생성, 365일 초과 파티션은
detach 후 즉시 drop (백업은 pg_dump 리허설 체계가 담당한다).

---

## 4. 개인정보 요청 처리

화면: `/privacy` (admin)

### 4.1 기한

**접수 + 10일.** 개인정보보호법 시행령 제41·43·44조. `create_privacy_request` 가 접수
시점에 `due_at` 을 못 박는다 — 화면·운영자가 계산하지 않는다.

### 4.2 절차

| 종류 | 집행 | 무엇이 일어나나 |
|---|---|---|
| `access` 열람 | 사람이 처리 | `privacy_access_report()` 로 보유 항목을 뽑아 정보주체에게 전달 |
| `delete` 삭제 | `execute_privacy_request()` | 이메일 파기 + `do_not_contact` + 재평가 영구 차단 |
| `suspend` 처리정지 | `execute_privacy_request()` | 파기하지 않고 접촉·export 만 차단 |
| `correct` 정정 | 사람이 처리 | 자동 집행할 것이 없다 |

1. **본인 확인** — 코드가 강제할 수 없다. 확인 전에는 열람 보고서를 내보내지 않는다
2. `처리 시작` (`in_progress`)
3. `열람 보고서` 로 무엇을 보유하는지 확인 (조회 자체가 감사 로그에 남는다)
4. 삭제·처리정지면 `집행` — **되돌릴 수 없다.** 화면이 확인을 두 번 요구한다
5. 완료 처리

### 4.3 보류·거절

**사유 없이 존재할 수 없다** (RPC 가 `reason_required` 로 거절한다). 사유 없는 미처리가
가장 위험한 상태다.

### 4.4 legal hold

보존 의무가 있는 자료(분쟁·수사 협조)는 삭제 요청으로 지울 수 없다 — 지우면 그 자체가
위법이다. `privacy_requests.legal_hold` 를 세우면 집행이 `409 legal_hold` 로 거절되고,
`emails.legal_hold` 가 걸린 개별 주소는 파기에서 제외되며 **건수가 응답에 남는다**
(조용히 남기지 않는다).

```sql
update privacy_requests set legal_hold = true, hold_reason = '<사건번호·근거>' where id = '<uuid>';
```

### 4.5 기한 초과

`/privacy` 가 기한 초과 건을 붉게 표시하고 상단에 건수를 띄운다. 헤더의 `Overdue` 가
0 이 아니면 그날 처리한다.

---

## 5. 백업 · 복구

### 5.1 리허설 (Phase 7 완료 기준)

**복원해 보지 않은 백업은 백업이 아니다.**

```bash
scripts/restore-rehearsal.sh                    # 로컬 컨테이너
scripts/restore-rehearsal.sh "$PROD_DSN"        # 운영 (읽기만 한다)
```

확인하는 것: 덤프 생성 → 빈 DB 복원 → **테이블별 행 수 대조** →
**RLS·정책·SECURITY DEFINER 함수·GRANT 복원** → **복원본에서 익명 접근이 여전히 차단되는지**.

행 수만 맞고 RLS 가 빠지면 복원된 DB 는 무방비다. 그래서 보안 객체를 함께 센다.

**최근 리허설 기록**

| 일자 | 대상 | 결과 |
|---|---|---|
| 2026-07-30 | 로컬 `leadops` (18MB) | ✅ 테이블 38개 · 행 14,027개 일치 · RLS 38 / 정책 64 / SECURITY DEFINER 32 · 익명 SELECT 차단 |

### 5.2 다른 클러스터로 옮길 때

역할은 **클러스터 전역**이라 `pg_dump` 에 들어 있지 않다. 역할을 먼저 옮긴다.

```bash
pg_dumpall --roles-only -d "$SOURCE_DSN" | psql "$TARGET_DSN"
pg_dump -Fc -d "$SOURCE_DSN" -f leadops.dump
pg_restore --no-owner -d "$TARGET_DSN" leadops.dump
```

### 5.3 오프사이트

설계서 4.3: Cloudflare R2 (10GB 무료). 덤프를 올리고 **보관 기간을 정한다** —
개인정보가 든 덤프를 무기한 보관하면 보유기간 원칙과 충돌한다.

---

## 6. 크래시 후 재개

워커를 강제 종료해도 안전하다. 확인 방법:

```sql
-- 만료된 lease
select id, stage, attempts, max_attempts, lease_expires_at from jobs
 where status = 'running' and lease_expires_at < now();
```

```bash
pnpm worker reap    # 만료 회수 (attempts >= max_attempts 면 dead 로, 아니면 백오프 후 재큐)
```

**fencing token** 이 좀비 워커의 늦은 쓰기를 무시한다 — lease 를 빼앗긴 워커의 결과 커밋은
`fence_token` 조건 때문에 0행이 되고, 워커는 그 자리에서 작업을 중단한다
(`apps/worker/src/worker.pg.test.ts` 가 검증한다).

> ⚠️ fencing 은 DB 의 늦은 쓰기만 막는다. 이벤트 루프가 멈춘 사이 나간 **외부 API 중복
> 호출과 비용은 막지 못한다.** `cost_ledger.entry_key` unique 가 이중 계상만 막는다.

---

## 7. 비용

```sql
select jsonb_pretty(public.db_capacity());  -- 용량
```

```
GET /api/costs   일별·제공자별 비용 · 상한 (admin 전용)
```

일 상한(`cost.daily_cap_krw`)은 워커가 **호출 전에 원장에 적어** 강제한다. 상한에 닿으면
그 자리에서 멈추고 실행을 `partial` 로 끝낸다 — 조용히 줄여서 계속하지 않는다.

> ❗ `/api/costs` 는 admin 전용이다. 검수자 권한으로 보면 `—` 이고 이것은 "0 원" 과 다르다.
