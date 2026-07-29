# 코드 리뷰 라운드 2 — Phase 1 DB 계층

> 대상: `packages/db/migrations/*.sql` · 비평자: codex (gpt-5.6-sol) · 2026-07-29
> 결과: 11건 중 **10건 수용·수정**, 1건 부분 수용. 수정 후 DB 통합 테스트 83 → 108개

## 요약

codex 에게 "테스트가 잡지 못할 결함"을 찾게 했다. 기존 테스트는 이미
RLS 전수·쓰기 차단·동시 승인 상한·fail-closed 를 검증하고 있었으므로,
남은 결함은 **동시성 순서**와 **시간에 따른 값 변화**에 몰려 있었다.

| 판정 | 건수 |
|---|---|
| 수용 → 수정 완료 | 10 |
| 부분 수용 (설계 변경으로 대응) | 1 |

---

## A. 수용 → 수정 완료

### C2-01 · `revoke_approval` 과 `decide_review_item` 의 교착 (HIGH)

승인은 **카운터 잠금 → leads 삽입**, 취소는 **leads 삭제 → 카운터 잠금** 순서였다.
두 트랜잭션이 서로의 자원을 반대 순서로 기다리면 교착이 난다.

→ 취소도 **카운터 → leads** 순서로 통일. 잠금 순서를 한 방향으로 고정하는 것이
교착 방지의 표준 해법이다.

### C2-02 · 취소 시 카운터 좌표가 재계산됨 (HIGH)

승인은 `current_date` + 당시 업종으로 카운터를 올리는데, 취소는 `decided_at::date` +
**현재** 업종으로 내렸다. 업체 업종이 바뀌었거나 세션 시간대가 다르면 엉뚱한 카운터가
감소한다.

→ `leads.approval_date` · `leads.approved_industry` 컬럼을 추가해 **승인 시점 좌표를
고정**하고, 취소는 그 값을 읽는다.

### C2-03 · 승인 시 점수를 다시 검증하지 않음 (HIGH)

`review_items` 만 잠그고 현재 `scores` 행을 읽었다. 워커는 `scores` 를 갱신·무효화할 수
있으므로, 검수자가 화면에서 본 점수가 승인 시점에는 무효일 수 있었다.

→ `for share` 로 점수를 잠그고 `invalidated_at is null` · `gate_passed` 를 재검사.
새 오류 코드 `score_invalidated` · `score_gate_not_passed`.

### C2-04 · `leads` 유일키 위반이 원시 오류로 노출 (MEDIUM)

재실행 attempt 에서 같은 업체가 다시 올라오면 `unique_violation` 이 그대로 튀어나와
API 가 사용자에게 설명할 수 없었다.

→ 삽입 전에 명시적으로 확인하고 `lead_already_exists` 도메인 오류를 낸다.

### C2-05 · nonce 검증과 소비가 비원자적 (HIGH)

`select ... where used_at is null` 로 확인한 뒤 조건 없이 `update` 했다. 두 요청이 모두
확인을 통과해 각자 진행할 수 있었다.

→ `update ... where used_at is null and expires_at > now()` **한 문장**으로 소비하고,
영향 행이 없으면 거부한다.

### C2-06 · rate limit 이 변경 가능한 행을 셈 (MEDIUM)

`emails.entered_at` 행 수를 셌는데, 같은 주소 재입력은 UPDATE 라 행이 늘지 않아
**과소 계산**되고, 다른 적재 경로가 `entered_by` 를 쓰면 **과대 계산**됐다.
동시 호출도 직렬화되지 않았다.

→ 추가 전용 `manual_entry_events` 테이블로 세고, 사용자 단위
`pg_advisory_xact_lock` 으로 동시 호출을 직렬화한다.

### C2-07 · `export_leads` 의 횟수 상한 경쟁 (HIGH)

읽고-검사하고-증가하는 3단계라 두 export 가 같은 값을 읽고 둘 다 통과할 수 있었다.

→ `update ... where id = ? and export_count < max` 로 **검사와 증가를 한 문장**으로.

### C2-08 · 상한에 걸린 리드 하나가 export 전체를 막음 (MEDIUM)

루프 안에서 예외를 던지면 앞서 처리한 갱신까지 롤백되어, 상한에 도달한 리드 하나가
그 범위의 export 를 영구히 막았다.

→ 후보 조건에 `export_count < max` 를 넣어 제외하고, 경쟁에서 밀린 행은 건너뛴다.
**다만 조용한 누락을 막기 위해** 제외된 건수를 감사 로그(`skipped_capped`)에 남긴다.

### C2-09 · fencing 이 스키마에만 있고 강제되지 않음 (HIGH)

`fence_token` 컬럼은 있었지만 증가·검증 경로가 DB 에 없었고, 워커에게 `jobs` 전체
UPDATE 권한이 있어 좀비 워커의 늦은 쓰기를 막을 수 없었다.

→ **획득·heartbeat·완료를 RPC 로 구현**하고(`acquire_job` / `heartbeat_job` /
`complete_job`), 워커의 `jobs` 권한을 **SELECT + INSERT 로 축소**했다.
모든 상태 전이는 `id + fence_token + locked_by + status='running'` 조건을 요구한다.

> 이 항목이 가장 값졌다. 설계서에는 "워커가 원자적 UPDATE 로 토큰을 증가시킨다"고
> 적혀 있었는데, 그것을 애플리케이션에 맡기는 한 **권한 모델이 그 약속을 무효로 만든다**.
> 불변식을 지키려면 불변식과 권한이 같은 곳에 있어야 한다.

### C2-10 · 관리자 부트스트랩·레지스트리 관리 경로 부재 (MEDIUM)

profiles·source_registry 가 읽기 전용이라 admin 승격과 소스 승인 변경을 할 수 없었다.

→ `set_profile_role` · `update_source_registry` RPC 추가.
**최초 admin 은 DB 소유자가 직접 승격**한다(운영 runbook 항목) — 권한 승격 경로를
애플리케이션에 두면 그 경로 자체가 공격면이 된다. 마지막 admin 의 자기 강등은 막았다.

### C2-11 · 설정 형식 오류가 정제되지 않음 (MEDIUM)

JSON 값을 곧바로 캐스팅해서, 값이 문자열이면 `22P02` 원시 오류가 났다.

→ `setting_number()` 헬퍼가 `jsonb_typeof` 를 먼저 확인하고 일관된
`configuration_error` 로 변환한다.

---

## B. codex 가 "견고하다"고 판정한 부분

- `is_admin()` 의 SECURITY DEFINER 실행 → profiles RLS 재귀 없음
- `revoke all on schema public from public` 이 owner 권한을 제거하지 않음
- 워커의 `USAGE, SELECT` sequence 권한이 `bigserial` 삽입에 충분함

---

## C. 이번 라운드에서 배운 것

기존 테스트는 **"금지된 일이 막히는가"** 를 잘 검증하고 있었다.
남은 결함은 전부 **"허용된 일이 잘못된 순서로 일어나면?"** 이었다.

- 교착: 두 함수가 같은 자원을 다른 순서로 잠금
- 좌표 드리프트: 올릴 때와 내릴 때 기준값이 다름
- 읽고-검사-쓰기: 세 단계를 나누면 그 사이에 끼어들 수 있음

세 가지 모두 **단일 트랜잭션 테스트로는 보이지 않는다**. 앞으로 상태를 바꾸는
함수를 추가할 때는 잠금 순서와 read-modify-write 를 먼저 점검한다.
