# codex 비평 라운드 2 — 판정 및 반영 결과

> 대상: `docs/00-plan.md` v2 · 비평자: codex (gpt-5.6-sol) · 판정일 2026-07-29
> 원본 비평: `docs/critique/round2-codex-raw.md` (41건)
> 결과: `docs/00-plan.md` **v3**

## 요약

| 판정 | 건수 |
|---|---|
| 수정 완료 확인 (v2가 실제로 고침) | 7 |
| 전면 수용 → v3 반영 | 26 |
| 부분 수용 (수정해서 반영) | 5 |
| 보류 (내 도구로 재확인 불가) | 2 |
| 반박 | 1 |
| **합계** | **41** |

---

## A. BLOCKER — 전면 수용

### R2-01 · 업종 비율 공식이 첫 승인부터 거부한다 (BLOCKER · **검산 확인 · v2가 틀림**)

v2의 `decide_review_item`:
```sql
if (v_industry_cnt + 1)::numeric / (v_counter.approved_total + 1) > v_share_max then
  raise exception 'industry_share_exceeded';
```
첫 승인 시 `v_industry_cnt = 0`, `approved_total = 0` → **`1/1 = 1.0 > 0.6` → 항상 예외.** 어떤 업종의 첫 건도 승인할 수 없어 승인 기능 전체가 동작하지 않습니다. 비율식은 순서 의존적이라 근본적으로 부적합합니다.

**v3 반영 — 순서 독립적 절대 쿼터로 교체**
```sql
v_industry_quota := floor(v_cap * v_share_max);   -- 50 × 0.6 = 30
if v_industry_cnt + 1 > v_industry_quota then
  raise exception 'industry_quota_exceeded';
end if;
```

### R2-02 · 네이버 약관 — ORS를 fail-closed로 (BLOCKER · **부분 수용 · 근거는 여전히 미검증**)

codex는 라운드 2에서 약관 7.3②(스팸·광고 정보 작성·전송 목적 이용 금지), 7.3③(지역정보의 광고 영업 이용 금지), 검색 특약 2.1(결과의 독립 노출·비왜곡)을 확인했다고 주장합니다.

**나는 이를 재확인하지 못했습니다.** `developers.naver.com` 은 내 WebFetch 도구에서 차단되고, 검색으로도 해당 조항 문언이 노출되지 않았습니다. 따라서 **조항 번호·문언은 여전히 미검증**으로 기록합니다.

**다만 처방은 수용합니다.** 조항이 맞든 틀리든 fail-closed 설계는 불확실성 하에서 옳고 비용이 거의 없습니다.

**v3 반영**
- `FEATURE_ORS` 기본값 **`off`**
- 활성화 조건: `source_registry['naver_search'].approved = true` **AND** `written_approval_ref` 값 존재. 둘 중 하나라도 없으면 어댑터가 **부팅 거부**
- ORS 배점은 **검증 전까지 0점** (shadow feature로 산출·기록만). Phase 4 확증 검증 통과 + 서면 허용 확보 후에만 배점 활성화
- ORS 없이도 성립하는 **축소 파이프라인**을 1급 경로로 정의: 공식 채널 RSS·YouTube 기반 "최근 콘텐츠 활동 부족" 축만으로 판정

### R2-03 · 수집 근거와 접촉 근거가 분리되지 않아 콜드 리드 export가 사실상 불가 (BLOCKER · 수용)

v2는 `consent_basis`를 nullable로 두고 "처리근거 없는 리드는 export 제외"라고만 썼습니다. 승인 RPC는 이 값을 채우지 않으므로 **규칙대로면 export 가능 리드가 0에 수렴**합니다. 정보통신망법 제50조는 영리목적 광고성 정보 전송에 수신자의 명시적 사전 동의를 원칙으로 하므로, "공개된 업무용 이메일"이라는 사실이 수신 동의를 뜻하지 않습니다.

**v3 반영 — 두 근거를 분리하고 둘 다 NOT NULL**
```sql
create type collection_basis as enum
  ('public_api_field','manual_from_public_site','provided_by_subject');
create type contact_basis as enum
  ('pending_legal_review','explicit_consent','existing_transaction_6m',
   'legitimate_interest_claimed','not_permitted');
```
- `emails.collection_legal_basis` — 어떻게 취득했는가 (NOT NULL)
- `leads.contact_legal_basis` — **연락해도 되는가** (NOT NULL, 기본값 `pending_legal_review`)
- `/api/leads/export` 는 `contact_legal_basis IN ('explicit_consent','existing_transaction_6m')` 인 리드만 반환. `legitimate_interest_claimed` 는 **법률 의견서에 근거가 명시된 경우에만** admin이 설정 가능
- **Phase -1 법률 의견서의 핵심 질문**: 국내에서 사업자 공개 업무용 이메일로의 B2B 콜드 아웃바운드가 어떤 조건에서 허용되는가. **이 답이 "불가"면 제품의 outbound 목적 자체를 재협상해야 합니다.** 이것은 기술로 해결할 수 없는 문제이며, 계획서에 그렇게 명시합니다.

---

## B. HIGH — 전면 수용 (v3 반영)

| ID | 지적 | 검증 | v3 반영 |
|---|---|---|---|
| R2-04 | 네이버 Search API의 API HUB 이관 누락 | **재확인 불가** (도메인 차단). codex 인용만 존재 | `NaverSearchAdapter`를 `legacy`/`apihub` 두 구현으로 분리. API HUB 약관·쿼터·가격을 Phase -1 확인 항목에 추가 |
| R2-05 | Phase 4에서 "업종별로도 n=111 충족" 은 산술 오류 | **맞음.** 업종별 60 < 111이고 평가자 2인은 표본 수를 늘리지 않음 | **pooled 검정을 유일한 1차 분석으로 사전등록**, 업종별은 탐색적 보고만 |
| R2-06 | Phase 0의 `CI 상한 ≥ 0.4` 는 `ρ̂≈0.24` 도 통과시킴 | **맞음** (n=120에서 CI 폭 ±0.17 수준) | Phase 0 판정을 **`stop` / `inconclusive`** 두 값만 산출. **긍정 go 판정과 SLA 확정 금지** |
| R2-07 | 워커가 연락처 페이지 본문까지 자동 fetch + 캐시하면 이메일이 자동 유입 | **맞음.** 방어선을 스스로 흐림 | `contact_pages` 탐지는 **링크 URL·앵커 텍스트만** 사용. 대상 페이지 **본문은 fetch·캐시하지 않음**. `http_cache.body_excerpt` 에 `@` 포함 시 저장 거부 |
| R2-08 | `acquisition_method='manual_entry'` 는 라벨일 뿐 증거가 아님. `enter_contact_email` SQL 부재 | **맞음** | 함수 전문 작성. `review_item`·회사·`contact_pages.url`·행위자·시각 결속, 사용자당 rate limit, UI nonce, 감사 로그 |
| R2-09 | ORS 고정 분모 30 + `search_hits` 유일키가 채널 내부에만 작동 | **맞음.** `unique(aggregate_id, url_hash)` 는 provider별이라 채널 간 중복 제거 불가 | 분모를 `min(30, total_returned)` 로 변경. 채널 간 중복 제거용 `unique(run_id, company_id, keyword, url_hash)` 추가. 배점은 R2-02에 따라 검증 전 0 |
| R2-10 | 3축 분리가 다중공선성을 제거하지 못하고 '문제 크기' 안에 다시 합침 | **맞음** | Phase 0/4에서 **축 간 상관·VIF·증분 설명력 측정**을 완료 기준에 추가. VIF > 5 이면 하위 항목 통합 |
| R2-11 | 예산 신호 상호작용 규칙의 `problem < 32` 분기는 게이트 때문에 dead code | **맞음.** 실제로는 high→10, low→4 인 단순 가점 | 조건을 `axis_problem` 이 아니라 **`clear_gap` 존재 여부**로 변경 (아래 D절) |
| R2-13 | 260MB 용량 모델이 하한이고 영구 테이블 누적 누락 | **맞음** | 30/180/365일 p50·p95 모델로 재작성. `search_aggregates` 파티셔닝·보존기간 명시 |
| R2-14 | `is_related=true`만 저장은 API 비용을 줄이지 않고 재현성 훼손 | **맞음** | classifier 버전·전체 URL 해시 목록·반환건수 분포·음성 표본 5%를 함께 보존. `search_hits(collected_at)` 인덱스 추가 |
| R2-15 | 70:30 분할은 소진을 약 한 달 반 늦출 뿐 | **검산 맞음.** U=30,000 · 신규 280/일 → 107영업일 | 아래 D절에서 재설계 |
| R2-16 | 재판정 상태 전이가 깨져 카운터·리드·검수 상태 불일치 | **맞음** | 허용 전이를 `pending → approved\|rejected` 로 고정. 관리자 정정은 별도 보상 트랜잭션 `revoke_approval()` |
| R2-17 | `on conflict do nothing` 이 승인 실패를 성공으로 위장 | **맞음** | `ON CONFLICT` 제거 + `GET DIAGNOSTICS ROW_COUNT` 로 정확히 1행 확인, 아니면 전체 실패 |
| R2-18 | 카운터가 run별이라 수동 run 추가로 일 50건 우회 가능 | **맞음** | 카운터 키를 `(approval_date, industry)` 로 변경 |
| R2-19 | 설정 NULL이 제한을 fail-open으로 만듦 | **맞음.** `NULL > x` 는 NULL → IF에서 false → 통과 | `SELECT ... INTO STRICT` + 범위 CHECK + `configuration_error` 예외. **run 의 `settings_snapshot` 에서 읽음** |
| R2-20 | "모든 쓰기는 RPC만"이 DDL로 뒷받침되지 않음 (`emails`·`contact_pages`·`approval_counters` RLS 없음) | **맞음** | 전 public 테이블 RLS 열거 테스트 추가. `approval_counters` 는 authenticated 에 완전 비공개 |
| R2-21 | 재실행 설계가 DDL과 충돌 — 유일키에 attempt 없음 | **맞음** | `run_attempts` 를 1급 엔터티로. 모든 관측·결과·stage 유일키에 `attempt_id` 포함 |
| R2-22 | 복합 FK가 `score_id` 를 결속하지 못함 | **맞음.** 두 FK가 독립이라 서로 다른 score 조합 가능 | `scores` 에 `unique(id, run_id, company_id)` 추가 후 **단일 복합 FK** `(score_id, run_id, company_id)` |
| R2-23 | `scores.observation_id` 하나로는 재현성 부족 | **맞음** | `score_inputs` 연결 테이블 + `rule_version`·`classifier_version` 기록 |
| R2-24 | reaper의 `attempts >= max_attempts` 처리 미정의 | **맞음** | 단일 상태 전이 SQL 제시. heartbeat·결과 커밋을 `job_id AND fence_token AND locked_by` 로 조건화 |
| R2-25 | 2분 lease는 가용성 파라미터일 뿐 안전성 근거 아님 | **맞음** | 스테이지별 p99 기반 lease. 외부 호출에 idempotency key 전달 |
| R2-26 | 개인정보 필드가 전부 nullable, 요청 처리 증적 테이블 없음 | **맞음** | `privacy_requests` 테이블 신설(접수·처리·보류·파기 증적, legal hold). 필드 NOT NULL 화 |
| R2-27 | 국외이전이 문장 수준 | **맞음** | Phase -1에 리전·수탁자·이전항목 흐름도 산출물 추가. 직렬화 경계에서 필드 차단 |
| R2-28 | 7~21건/일이 사업 타당성을 입증하지 않음 | **맞음** | **단위경제 모델을 계획서에 추가** (p10/p50/p90). 단, 전환율은 에이전시 내부 데이터가 필요하므로 **입력 요청 항목**으로 명시 |
| R2-30 | `leadops_worker` 최소권한이 DDL로 없음 | 맞음 | `CREATE ROLE` + schema usage + 테이블별 grant + 회전 runbook |
| R2-31 | SSRF 주소 정규화 범위 불완전 | **맞음.** IPv4-mapped IPv6, NAT64, 숫자형 IP, userinfo 누락 | 검증된 IP 분류 라이브러리 사용 + **연결 직전 최종 peer IP 재확인** |
| R2-32 | 의료광고 3단 분리가 스키마·권한에 없음 | 맞음 | **MVP에서 대외 문구를 완전히 제외**하고 `use_scope='internal_only'` 를 export snapshot에 강제 |
| R2-34 | `extensions` 스키마 생성 누락, 타입 비수식 | 맞음 | `create schema if not exists extensions` + 완전 수식 타입 |

---

## C. 부분 수용

### R2-12 · 게이트 임계값 조합의 정합성 — **반박(부분)**

codex: `problem=41, propensity=10, confidence=9` 는 총점 60으로 통과하는데 축 최소값 `32+10+9=51` 은 축 게이트를 모두 통과하고도 총점 때문에 탈락하므로 총점 조건이 무의미하다.

**반박:** 이는 결함이 아니라 **의도된 이중 조건**입니다. 축 하한은 "한 축 몰빵 방지"(필요조건), 총점 60은 "전체 크기 확보"(충분조건)입니다. 둘 중 하나만 두면 각각의 실패 모드가 생깁니다. 또한 **총점 60점 이상은 요구사항 원문의 명시적 조건**이라 임의로 제거할 수 없습니다.

**수용한 부분:** 9점의 여유가 어느 축에서 와도 동일하게 취급되는 근거가 없다는 지적은 맞습니다. → **계획서에 그 설계 의도를 명시**하고, Phase 4에서 실제 승인 결과로 임계값을 보정하는 항목을 추가합니다.

### R2-29 · YouTube 쿼터 — 수용, 계산 수정

`search.list` 는 호출당 100 units 이므로 100업체 조회만으로 10,000 units 를 전부 소진합니다. v2의 `~100 units×…` 표기는 무의미했습니다.
**v3:** 공식 유튜브 채널은 **홈페이지에서 발견한 채널 URL로 `channels.list`(1 unit)** 만 사용하고 `search.list` 는 쓰지 않습니다. 일 소비 약 100~300 units.

### R2-33 · 오병합률 검증 표본 — 수용, 기준 완화

n=30에서 오류 0건이어도 rule of three 상한은 `3/30 = 10%` 이므로 "≤3% 검증"은 불가능합니다.
**v3:** Phase 0 에서는 **점추정만 보고**하고 통과 기준을 제거. 확증은 Phase 4 확대 표본으로 이월.

### R2-41 · 월 5만 원의 명명 — 수용

**v3:** "월 운영비"를 **"월 인프라비"** 로 명확히 하고, 검수 인건비(월 44~55시간)를 **별도 항목으로 병기**합니다.

### R2-04 / R2-02 · 네이버 관련 2건 — 처방은 수용, 근거는 보류

위 A절 참조. **조항 번호·이관 공지는 내 도구로 재확인 불가**하여 사실로 확정하지 않되, fail-closed 설계와 Phase -1 확인 항목으로 반영합니다.

---

## D. 재설계가 필요한 2건 (v3 본문 반영)

### D-1 · 모집단 소진 (R2-15) — 70:30으로는 해결되지 않는다

```
U = 30,000 (가정, Phase 0에서 실측)
신규 280건/일 → 신규 소진 107영업일 (약 5개월)
이후 재평가만: cooldown 90일이면 이론상 최대 30,000/90 ≈ 333건/일
→ 원본 목표 400건/일 유지 불가
```
게다가 **같은 업체의 ORS·이메일 공개 여부가 90일마다 바뀐다는 근거가 없습니다.** 변경 없는 업체를 주기적으로 재검사하는 것은 API 예산과 검수자 시간을 태우는 일입니다.

**v3 설계**
1. **변경 탐지 우선.** 재평가는 `content_fingerprint` 변경·신규 콘텐츠 발행·가맹점 수 변동·상태 변경이 감지된 업체만. 무변경 업체는 **cooldown 만료만으로 재진입하지 않음**
2. 세 트랙의 **증분 수율을 각각 측정**: `new` / `changed` / `recontact`
3. **일일 목표를 고정값이 아니라 "가용 후보 수"의 함수로** 변경. 후보가 부족하면 그날은 적게 처리하는 것이 정상이며, 이를 `run.status = 'succeeded'` 로 취급(실패 아님)
4. Phase 0 산출물에 **소진 곡선 그래프와 월별 예상 리드 수**를 포함. 이것이 사업 판단의 핵심 입력

### D-2 · 예산 신호 상호작용 규칙 (R2-11) — 조건을 바꾼다

```
v2 (dead code)                          v3
high AND axis_problem >= 32 → 10        high AND clear_gap 존재      → 10
high AND axis_problem <  32 →  0        high AND clear_gap 없음      →  2
low                         →  4        low  AND strong 취약점 존재  →  6
                                        low  그 외                   →  3
```
`axis_problem >= 32` 는 게이트 통과 후보에서 항상 참이므로 분기가 죽어 있었습니다. **`clear_gap`(경쟁사 대비 명확한 격차)** 는 게이트에서 필수가 아니므로 실제로 변별력이 있습니다. 의미도 더 정확합니다 — "돈은 쓰는데 경쟁사보다 뒤처져 있다"가 우리가 찾는 리드입니다.

---

## E. 수정 완료 확인 (codex가 직접 인정)

R2-35 (Google CSE 제거) · R2-36 (경쟁사 결측) · R2-37 (robots/noindex) · R2-38 (MX 해석) · R2-39 (일정) · R2-40 (Phase -1) · R2-41 (예산, 명명만 보완)

---

## F. 남은 미해결 — 사용자 결정 필요

| # | 항목 | 왜 내가 결정할 수 없는가 |
|---|---|---|
| 1 | **콜드 아웃바운드 이메일의 적법성** (R2-03) | 법률 판단. 답이 "불가"면 제품 목적 재협상 필요 |
| 2 | **네이버 API 영업 목적 이용 허용 여부** (R2-02) | 네이버의 서면 회신 필요. 불허 시 ORS 없는 축소 제품 |
| 3 | **일 7~21건이 사업적으로 충분한가** (R2-28) | 에이전시의 전환율·고객가치 데이터 필요 |
| 4 | **검수 인건비 월 44~55시간 수용 가능 여부** (S-01) | 인력 배치 결정 |

---

## G. 라운드 3 — v3 수정 검증 (codex 좁은 확인 패스)

BLOCKER 및 SQL 관련 10개 항목만 좁게 재검증 요청.

| 항목 | codex 판정 | 조치 |
|---|---|---|
| R2-01 업종 비율 공식 | **FIXED** — `floor(50×0.6)=30`, 첫 승인 `1 > 30 = false` 통과 확인 | — |
| R2-17 `ON CONFLICT` 은폐 | **FIXED** — `GET DIAGNOSTICS` 검증 확인 | — |
| R2-18 수동 run 우회 | **FIXED** — `(approval_date, industry)` PK 확인 | — |
| R2-19 설정 fail-open | **FIXED** — `INTO STRICT` + NULL 검사 확인 | — |
| R2-16 재판정 | **FIXED** — `already_decided` + `revoke_approval()` 확인 | — |
| R2-22 복합 FK | **FIXED** — 단일 복합 FK 확인 | — |
| R2-02 ORS fail-closed | **FIXED** | — |
| R2-08 manual_entry 증거 | **PARTIAL** — `on conflict` 경로가 행위자·페이지를 재결속하지 않음 | ✅ **수정**: `do update` 에서 `entered_by`·`entered_at`·`source_contact_page_id`·`acquisition_method`·`collection_legal_basis` 전부 갱신 |
| R2-03 export 게이트 | **PARTIAL** — 선언만 있고 강제 SQL 없음 | ✅ **수정**: `export_leads()` 함수 작성. 접촉 근거·`do_not_contact`·보유기간·개인정보 요청 중복 검사·횟수 제한을 SQL로 강제 |
| R2-21 attempt_id | **PARTIAL** — `review_items` 에 `attempt_id` 없음 | ✅ **수정**: `review_items.attempt_id` 추가, `unique(attempt_id, company_id)`, run 단위 pending 중복 방지 부분 인덱스 |

### v3 편집이 **새로 만든** 결함 5건 (전부 수정)

| # | 결함 | 수정 |
|---|---|---|
| 1 | `run_attempts` 가 아직 생성되지 않은 `runs(id)` 를 참조 → 마이그레이션 실패 | `run_attempts` 정의를 `runs` **다음으로 이동** |
| 2 | `enter_contact_email` 이 참조하는 `review_view_nonces` 테이블 미정의 | 테이블 DDL 추가 (nonce·review_item·user·만료·1회용) |
| 3 | 업종 행만 `FOR UPDATE` → **서로 다른 업종의 동시 승인이 일 상한 50을 초과** 가능 | `approval_day_totals` 신설. **잠금 순서 고정: 일 총량 행 → 업종 행** (교착 방지) |
| 4 | `scores.run_id` 와 `scores.attempt_id` 정합성 미보장 | `run_attempts` 에 `unique(id, run_id)` 추가 후 `(attempt_id, run_id)` 복합 FK |
| 5 | ORS "부팅 거부" vs "shadow feature 산출" 모순 | **3-state 로 정리**: `off`(어댑터 미로드) / `shadow`(산출·배점 0) / `on`(배점 25). 부팅 거부는 `off` 가 아닌데 근거가 없을 때만 |

> 이 5건은 **codex의 비평이 없었으면 그대로 남았을 것**이고, 그중 3번(일 상한 초과)과 1번(마이그레이션 실패)은 실행 시점에 바로 드러나는 결함입니다.
