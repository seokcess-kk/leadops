# Outbound Lead Finder — MVP 설계서 v3

> 상태: **승인 대기** · v1 → v2 (codex 비평 32건) → **v3 2026-07-29 (codex 비평 41건 추가 반영)**
> 대상: 마케팅 에이전시 내부용
> 변경 내역: `docs/01-critique-round1.md` · `docs/02-critique-round2.md`

## 승인 전에 답이 필요한 4가지 (기술로 해결 불가)

| # | 질문 | 답이 "아니오"일 때 |
|---|---|---|
| 1 | **국내에서 사업자 공개 업무용 이메일로의 B2B 콜드 아웃바운드가 적법한가?** (정보통신망법 제50조) | 제품의 outbound 목적 자체를 재협상. 리드를 "발굴 후 다른 채널로 접촉"용으로 재정의 |
| 2 | **네이버 Open API를 영업 리드 발굴에 쓸 수 있는가?** (서면 확인 필요) | ORS 없는 축소 제품 — 공식 채널 활동량만으로 판정 |
| 3 | **일 7~21건이 사업적으로 충분한가?** | 목표·업종 범위 확대 또는 프로젝트 중단 |
| 4 | **검수 인건비 월 44~55시간을 배정할 수 있는가?** | `targets.final_max` 하향이 유일한 조정 수단 |

1·2번은 **Phase -1의 게이트**입니다. 답을 받기 전에 그 부분의 코드를 쓰지 않습니다.

---

## 0. 먼저 읽어야 할 5가지 결론

v1 대비 **제품 구조가 바뀐 부분**과 **가장 큰 리스크**를 앞에 둡니다. ⚠️ 는 이전 버전에서 뒤집힌 결론입니다.

### ⚠️ 결론 A. 홈페이지에서 이메일을 프로그램으로 수집할 수 없다 — 검수자 수동 입력으로 전환

**정보통신망법 제50조의2 제1항 (현행)**
> "누구든지 인터넷 홈페이지 운영자 또는 관리자의 **사전 동의 없이** 인터넷 홈페이지에서 **자동으로 전자우편주소를 수집하는 프로그램 그 밖의 기술적 장치를 이용하여** 전자우편주소를 수집하여서는 아니 된다."
> **벌칙 제74조** — 1년 이하의 징역 또는 1천만원 이하의 벌금

v1은 "수집 거부 의사가 명시된 홈페이지에서"라는 **2002년 신설 당시 입법 취지 문구**를 조문으로 오인했습니다. 이 문구는 국내 수천 개 사이트의 "이메일무단수집거부" 안내에 복사되어 퍼져 있지만 현행 요건이 아닙니다.

요건이 "운영자의 사전 동의"인 이상, 콜드 리드 발굴에서는 **동의 취득이 정의상 불가능**합니다. 따라서:

| 금지 | 허용 |
|---|---|
| 워커가 HTML을 파싱해 이메일 문자열을 추출·저장 | 워커가 **연락처가 있을 만한 페이지 URL**을 기록 (`contact_pages`) |
| 추출 후 조건부 폐기 | 검수자가 그 URL을 직접 열어 **눈으로 확인하고 수동 입력** |
| 이메일 패턴 조합·추측 | 공공데이터 API가 **필드로 제공**하는 이메일 (홈페이지 자동수집이 아님) |

`emails.acquisition_method ∈ {'manual_entry', 'public_api'}` 로 취득 경로를 **항상** 기록합니다. `'scraped'` 값은 스키마에 존재하지 않습니다.

> 이 문서는 법률 자문이 아닙니다. **Phase -1에서 국내 IT·개인정보 전문 변호사 검토를 반드시 거칩니다.**

### ⚠️ 결론 B. 이메일이 사전 게이트에서 후행 단계로 이동한다 — 파이프라인 순서가 바뀐다

```
v1  수집 → 제외 → 홈페이지 → [이메일 추출·MX 게이트] → 검색분석 → 점수 → 검수
v2  수집 → 제외 → 홈페이지 → 검색분석 → 경쟁사 → 점수 → 검수 후보
                                                              ↓
                          검수자가 상세 확인 → 승인 의사 → [연락처 페이지 열람 → 이메일 수동 입력]
                                                              ↓
                                              문법·DNS·MX 검증 → 통과 시 리드 확정
```

부수 효과 두 가지:
- **좋은 쪽**: 이메일 때문에 점수 계산 전에 후보의 60~75%가 탈락하던 구조가 사라져, 분석 자원이 낭비되지 않습니다.
- **나쁜 쪽**: 검수자에게 실제 작업이 생깁니다. 승인 후보당 연락처 확인 60~90초 × 최대 50건 = **하루 50~75분**. 이 인적 비용은 운영 설계에 명시했습니다(8.4절).

### ⚠️ 결론 C. "네이버 검색 상위 10개 순위"는 수집할 수 없고, 대체 지표의 의미도 v1보다 좁다

네이버 통합검색 결과(`search.naver.com`)는 robots.txt·이용약관상 자동 수집 대상이 아닙니다. 공식 **검색 오픈 API**는 통합검색 SERP가 아니라 `blog`/`cafearticle`/`webkr`/`news`/`local` **각각의 독립 인덱스**를 반환합니다.

v1은 이를 `SoSR(Share of Search Results)`이라 부르고 "검색 점유"로 해석했는데, 이는 과장입니다. 채널별로 최대 반환 건수가 다르고(`local`은 5건, 나머지는 100건) 분모조차 호환되지 않습니다.

**v2 재정의 → v3에서 fail-closed로 강화**
- 지표명: **`ORS` — Open-API Result Share (네이버 Open API 콘텐츠 회수 점유율)**
- 분모: `blog`/`cafe`/`web`/`news` 각 **`min(30, total_returned)`** (v2의 고정 30은 실제 반환이 10건인 채널을 부당하게 낮게 평가함)
- URL 정규화 후 **채널 간** 중복 제거 — `unique(run_id, company_id, keyword, url_hash)` 로 DDL 강제
- **브랜드 키워드와 비브랜드 키워드를 합산하지 않고 분리 산출**
- `local`은 ORS에서 제외, "플레이스 등록 여부" boolean 신호로만 사용
- UI·리포트에서 "검색 노출·순위·점유율" 표현 **금지**. "네이버 Open API 기준 콘텐츠 회수량"으로만 표기

**⚠️ v3 — ORS는 검증·허용 전까지 배점 0의 shadow feature다**

네이버 Open API를 영업 리드 발굴에 사용하는 것이 약관상 허용되는지 **확인되지 않았습니다**(R2). codex는 약관 7.3②·7.3③·검색 특약 2.1을 근거로 위반 가능성이 높다고 주장했으나, `developers.naver.com` 이 내 도구에서 차단되어 **조항 문언을 재확인하지 못했습니다.** 사실로 확정하지 않되, 불확실성 하에서 안전한 쪽을 택합니다.

**`FEATURE_ORS` 는 boolean이 아니라 3-state 입니다.** (v3 첫 편집에서 "부팅 거부"와 "shadow feature 산출"이 모순됐던 것을 정리)

| 값 | 전제 조건 | 어댑터 | ORS 산출 | 배점 | 게이트 |
|---|---|---|---|---|---|
| **`off`** (기본값) | 없음 | **로드하지 않음** | ❌ | 0 | 모드 B |
| `shadow` | `approved = true` **AND** `written_approval_ref IS NOT NULL` | 로드 | ✅ 산출·기록만 | 0 | 모드 B |
| `on` | 위 조건 **AND** Phase 4 확증 검증 통과 | 로드 | ✅ | 25 | 모드 A |

```
부팅 검사 (worker 시작 시)
  FEATURE_ORS = 'off'    → NaverSearchAdapter 미등록. 정상 부팅
  FEATURE_ORS ≠ 'off' 인데 전제 조건 미충족
                         → 부팅 실패 (조용한 폴백 금지)
```
즉 **"부팅 거부"는 `shadow`/`on` 을 켜놓고 근거가 없을 때만** 발생합니다. 기본값 `off` 에서는 어댑터가 아예 로드되지 않으므로 모순이 없습니다.

**ORS 없이 성립하는 축소 파이프라인을 1급 경로로 유지합니다.** 공식 채널 RSS·YouTube `channels.list` 기반 "최근 콘텐츠 활동 부족" 축만으로도 취약 업체 판정이 가능하며, 이 경로는 네이버 API에 의존하지 않습니다.

> **API HUB 이관 (미검증):** codex는 네이버 Search API가 API HUB로 이관 중이며 신규 신청 창구·인증·약관·요금이 바뀐다고 지적했습니다. 재확인하지 못했으나 리스크가 크므로 `NaverSearchAdapter` 를 `legacy` / `apihub` 두 구현으로 분리하고, Phase -1 확인 항목에 포함합니다.

### ⚠️ 결론 D. 모집단은 유한하다 — 신규 소진 후를 설계하지 않으면 3~4개월 만에 멈춘다

국내 치과의원 + 피부과·성형외과 표방 의원 + 공정위 등록 가맹본부의 총량 `U`는 수만 개 규모로 **유한**합니다. 신규만 처리하면 `U/400` 영업일에 고갈되고, `U=30,000`이면 **75영업일(약 3.5개월)** 입니다. v1에는 재검색 전략이 한 줄도 없었고, `leads.company_id UNIQUE` 는 과거 승인 업체의 재진입을 영구 차단했습니다.

**⚠️ v3 — v2의 "신규 70 : 재평가 30"은 소진을 약 한 달 반 늦출 뿐이다**

```
U = 30,000 (가정) · 신규 280건/일 → 신규 소진 107영업일 (약 5개월)
이후 재평가만 가능: cooldown 90일이면 이론상 최대 30,000/90 ≈ 333건/일
→ 원본 목표 400건/일을 유지할 수 없다
```

더 근본적인 문제는 **같은 업체의 콘텐츠 활동·이메일 공개 여부가 90일마다 바뀐다는 근거가 없다**는 것입니다. 변경 없는 업체를 주기적으로 재검사하는 것은 API 예산과 검수자 시간을 태우는 일입니다.

**v3 설계 — 주기가 아니라 변경이 재평가를 촉발한다**

1. **변경 탐지 우선.** 재평가 대상은 `content_fingerprint` 변경 · 신규 콘텐츠 발행 · 가맹점 수 변동 · 사업자 상태 변경이 감지된 업체만. **무변경 업체는 cooldown 만료만으로 재진입하지 않습니다.**
2. **세 트랙의 증분 수율을 각각 측정**: `new` (미관측) / `changed` (변경 감지) / `recontact` (승인 후 재접촉 자격 도래)
3. **일일 목표를 고정값이 아니라 "가용 후보 수"의 함수로.** 후보가 부족한 날은 적게 처리하는 것이 정상이며, 이를 `run.status = 'succeeded'` 로 취급합니다(실패 아님). 목표 미달을 실패로 보면 시스템이 무리한 재검사를 하게 됩니다.
4. **Phase 0 산출물에 소진 곡선과 월별 예상 리드 수 포함.** 이것이 사업 판단의 핵심 입력입니다.

**공통 기반**
- `company_observations` — 업체별 관측 이력 시계열
- `companies.last_scanned_at`, `next_eligible_at`, `scan_count`, `content_fingerprint`
- cooldown(하한): 미승인 90일 / 제외 180일 / 승인 후 재접촉 365일 (전부 설정값). **cooldown은 재진입의 필요조건이지 충분조건이 아닙니다.**
- `leads` 유일성: `UNIQUE(company_id)` → `UNIQUE(company_id, run_id)` + `do_not_contact` 플래그
- **Phase 0에서 `U`를 API 전수 조회로 실측**

### 결론 E. 일 최종 50건은 달성 불가에 가깝다 — 목표가 아니라 상한이다

v1은 "15~35건/일"이라고 썼는데 자체 가정으로 계산하면 틀린 수치입니다. v2 구조로 다시 계산하면:

```
원본 400 → 기본통과 175 → 홈페이지 confirmed|likely 70~80% → 123~140
→ 상세분석 상한 100 → 점수·취약점 게이트 통과 40~60% → 40~60
→ 검수자 승인 60~70% → 24~42
→ 이메일 수동 확인 성공 30~50% → 【7 ~ 21건/일】
```

50건을 채우려면 검수 후보를 지금의 4~7배로 늘려야 하고, 그러면 검수자 인적 비용과 API 예산이 함께 폭증합니다.

**반영: 50은 `targets.final_max`(상한)으로만 유지하고, 실제 SLA는 Phase 0 실측으로 확정합니다.**

**⚠️ v3 — 이 숫자가 사업적으로 충분한지는 내가 판단할 수 없다**

월 22영업일 기준 **154~462건/월**이고 검수 인건비는 **월 44~55시간**입니다. 그런데 이 중 실제로 매출이 되는 비율은 다음이 있어야 계산됩니다.

| 입력 필요 (에이전시 내부 데이터) | 용도 |
|---|---|
| 적법하게 접촉 가능한 리드 비율 | 결론 A/승인 전 질문 1에 종속 |
| 접촉 → 회신률 | 콜드 아웃바운드 실적 |
| 회신 → 미팅 전환율 | |
| 미팅 → 계약 전환율 | |
| 고객 1건당 연간 계약 가치 | |

이 5개 값의 p10/p50/p90을 주시면 단위경제 모델을 계산해 드립니다. **없이는 "사업성이 있다/없다"를 말할 수 없고, 있는 척하지 않겠습니다.** 특히 질문 1의 답이 "콜드 아웃바운드 불가"이면 **export 가능 수율이 0에 수렴**하므로 다른 모든 숫자가 무의미해집니다.

---

## 1. 요구사항과 MVP 범위

### 1.1 목적

무작위 대량 수집이 아니라, **검색 수요는 있으나 검색 결과물·콘텐츠 점유가 경쟁사보다 부족한 업체**를 찾아 영업 가치가 높은 리드만 선별한다. 연락처는 공개된 업무용 이메일에 한정하며, **취득 경로는 법적으로 안전한 것만 사용한다**(결론 A).

### 1.2 포함 (In Scope)

| 영역 | 내용 | v1 대비 |
|---|---|---|
| 수집 | 공공 API 기반 후보 수집·정규화·중복 제거 | — |
| 재검색 | 관측 이력·cooldown·변경 탐지 기반 재평가 트랙 | **신규** |
| 제외 | 폐업·휴업, 대형, 가맹점 100개 이상, 네트워크 통합 | — |
| 홈페이지 | 공식 판별 5단계 + **연락처 페이지 URL 후보 기록** | 이메일 추출 **삭제** |
| 검색 분석 | 네이버 Open API 기반 **ORS** | SoSR→ORS, 35→25점 |
| 채널 분석 | 공식 블로그 RSS·유튜브 활성도, 발행 주기, 콘텐츠 성격 | — |
| 경쟁사 | 유사 경쟁사 3곳 선정·비교 (**유효 2곳 미만이면 unavailable**) | 결측 처리 **신규** |
| 점수 | **3축 분리** (문제 크기 / 구매 가능성 / 데이터 신뢰도) 100점 | 단일 총점 → 3축 |
| 검수 | 상세 패널 + **연락처 수동 입력** + MX 검증 + 승인·제외 | 수동 입력 **신규** |
| 개인정보 | 처리근거·보유기간·파기·열람/삭제/처리정지 워크플로 | **신규** |
| 운영 | 평일 06:00 자동 실행, 이력, 실패 재실행, 설정, 비용 추적 | — |
| 보안 | **SSRF/DNS rebinding/stored XSS 방어** | **신규** |
| 권한 | `admin` / `user` 2단계 | — |

### 1.3 제외 (Out of Scope) — 확장 지점만 남긴다

이메일 발송, 오픈·클릭·회신 추적, 후속 시퀀스, CRM 동기화, 계약·매출 관리.

**확장 seam:** `leads.export_status` / `external_crm_id` / `exported_at`, `outbox` 이벤트 테이블, 승인 리드 CSV·JSON export API.

**단, export는 통제한다(S-02):** 워터마크(요청자·시각), `audit_log` 필수 기록, 다운로드 횟수 제한, `do_not_contact` 및 처리근거 없는 리드 자동 제외.

### 1.4 일일 목표치 (전부 설정 변경 가능)

| 단계 | v1 | **v2** | 설정 키 |
|---|---|---|---|
| 원본 후보 | 300~500 | 300~500 (**신규 70% / 재평가 30%**) | `targets.raw_min`·`raw_max`·`rescan_ratio` |
| 기본 통과 | 150~200 | 150~200 | `targets.basic_pass` |
| 상세 분석·검수 후보 | 최대 100 | 최대 100 | `targets.review_max` |
| 최종 승인 저장 | **목표 50** | **상한 50 · 실 SLA는 Phase 0 확정 (추정 7~21)** | `targets.final_max` |
| 단일 업종 비중 상한 | 60% | 60% | `targets.industry_share_max` |

### 1.5 초기 업종

병원(피부과·성형외과·치과) / 프랜차이즈(가맹본부만, 가맹점 100개 이상 기본 제외). 동일 네트워크·다지점은 본원·대표 브랜드·법인 기준 통합.

### 1.6 비기능 요구

월 운영비 5만 원 이하 · `FEATURE_LLM=off` 로 전체 파이프라인 동작 · 데이터 소스 어댑터 교체 가능 · robots.txt 준수, 속도 제한, 타임아웃, 재시도 제한, 지수 백오프, 실패 로그, 중단·재처리.

---

## 2. 기술적 실현 가능성 · 핵심 위험

### 2.1 실현 가능성

| 기능 | 실현성 | 근거 |
|---|---|---|
| 병원·프랜차이즈 후보 수집 | **높음** | HIRA·공정위 공공 API |
| 폐업·휴업 판정 | **높음** | 국세청 상태조회 API (사업자번호 확보 시) |
| 공식 홈페이지 판별 | **중간** | 규칙 기반 다신호. 정확도는 표본 검증 필요 |
| 연락처 페이지 후보 탐지 | **높음** | 링크 텍스트·URL 패턴 |
| 이메일 확보 | **중간(인적)** | 검수자 수동. 자동화 불가(결론 A) |
| MX 검증 | **높음** | Node `dns.resolveMx` |
| ORS 산출 | **중간** | 네이버 Open API. **약관 확인 선행 필요** |
| 공식 채널 활성도 | **중간** | 블로그 RSS·YouTube Data API 가능 / **인스타그램은 불가** |
| 경쟁사 3곳 선정 | **중간** | 업종·행정동·규모 매칭. 정확도는 사람 평가 |
| 점수·추천·대시보드 | **높음** | 규칙 기반 · 표준 CRUD |

### 2.2 핵심 위험

| # | 위험 | 심각도 | 완화책 | 검증 |
|---|---|---|---|---|
| R1 | **정보통신망법 50조의2** | **BLOCKER** | 자동 이메일 추출 제거, 수동 입력 전환, **변호사 검토** | P-1 |
| R2 | **네이버 API 약관상 영업 목적 이용 가능 여부** — 조항 문언 미확인 | **BLOCKER** | 약관 전문 확보 → 애매 시 네이버 서면 문의. 불허 시 ORS 없는 축소 파이프라인으로 폴백 | P-1 |
| R3 | **모집단 소진** | **HIGH** | 관측 이력·cooldown·재평가 트랙. `U` 실측 | P0 |
| R4 | **일 50건 미달** | **HIGH** | 상한으로 재정의, 실측 SLA 합의 | P0 |
| R5 | **정보통신망법 제50조 (광고성 정보 전송)** — 수집이 합법이어도 사용이 불법이면 제품 목적 미달성 | **BLOCKER** | `collection_legal_basis` / `contact_legal_basis` 분리(둘 다 NOT NULL), `do_not_contact`·`opt_out_at`. **접촉 근거 없는 리드는 export 불가.** 법률 의견서가 "콜드 아웃바운드 불가"면 outbound 목적 재협상 | P-1 |
| R6 | 개인정보보호법 (처리근거·보유기간·권리) | **HIGH** | 항목별 개인정보 판정, 보유기간·파기·열람/삭제/처리정지 워크플로 | P7 |
| R7 | 개인정보 국외이전 (Hetzner/Supabase/Anthropic) | **HIGH** | 리전·수탁자·이전항목 명시. **이메일·담당자 정보는 해외 LLM·로그 전송 기술적 차단** | P1 |
| R8 | **SSRF / DNS rebinding / stored XSS** | **HIGH** | 사설망 차단, redirect 재검증, scheme·port 허용목록, 압축 후 크기 제한, HTML sanitize + CSP | P2 |
| R9 | Supabase Free 500MB 초과 → read-only 전환 | **HIGH** | 원본 SERP 행 미저장. 관련 문서만 30일 + 집계 영구 | P4 |
| R10 | 공식 홈페이지 오판 (애그리게이터를 공식으로) | MEDIUM | 도메인 블랙리스트 + 다신호 합의 | P3 |
| R11 | 경쟁사 결측 → 허위 취약점 | MEDIUM | 유효 2곳 미만이면 `unavailable`, **재정규화 금지** | P5 |
| R12 | 점수 항목 다중공선성 → 60점 군집 | MEDIUM | 3축 분리 + 축별 임계값 | P5 |
| R13 | 인스타그램 활성도 수집 불가 | MEDIUM | 링크 존재만 기록, 활성도 `unavailable` | P4 |
| R14 | 의료법 의료광고 (제56조) | MEDIUM | 내부 분석 / 대외 제안 / 환자 대상 광고를 **데이터·권한으로 3단 분리** | P6 |
| R15 | 워커 실행 시간 초과 | MEDIUM | 단계별 잡 큐 + 동시성 제어, 업체당 시간 실측 | P0 |

### 2.3 명시적으로 하지 않는 것

CAPTCHA·로그인·페이월 우회 · 프록시 로테이션 · 탐지 회피 · **홈페이지 이메일 자동 추출** · 이메일 주소 추측 · 유출/구매 이메일 · 개인 이메일 수집 · SMTP 검증 · 네이버 통합검색 SERP 스크래핑

---

## 3. 데이터 수집원 후보와 정책 위험

### 3.1 1차 수집원 (후보 발굴) — 전부 공공 API

| 소스 | 용도 | 비용 | 위험 | 어댑터 |
|---|---|---|---|---|
| [HIRA 병원정보서비스](https://www.data.go.kr/data/15001698/openapi.do) | 피부과·성형외과·치과 전수(명칭·주소·전화·진료과목·좌표) | 무료 | 낮음 | `HiraHospitalSource` |
| [HIRA 의료기관별상세정보](https://www.data.go.kr/data/15001699/openapi.do) | 의사 수·장비 → 규모 판정 | 무료 | 낮음 | `HiraHospitalDetailSource` |
| [공정위 브랜드 목록](https://www.data.go.kr/data/15125467/openapi.do) | 가맹본부·브랜드·법인/사업자번호 | 무료 | 낮음 | `FtcBrandSource` |
| [공정위 브랜드별 가맹점 현황](https://www.data.go.kr/data/15110241/openapi.do) | 가맹점 수 → 100개 이상 제외 | 무료 | 낮음 | `FtcFranchiseCountSource` |
| [공정위 정보공개서 목록](https://www.data.go.kr/data/15125569/openapi.do) | 본부 식별·처리상태 | 무료 | 낮음 | `FtcDisclosureSource` |
| LOCALDATA 인허가 | 영업/휴업/폐업 상태 보조 | 무료 | 낮음 | `LocalDataSource` |

### 3.2 2차 수집원 (검증·보강)

| 소스 | 용도 | 한도 | 위험 |
|---|---|---|---|
| [국세청 사업자등록 상태조회](https://www.data.go.kr/data/15081808/openapi.do) | 휴업·폐업·폐업일자 | 1회 100건 / 일 100만건 | 낮음 |
| [네이버 검색 오픈 API](https://developers.naver.com/docs/serviceapi/search/blog/blog.md) `blog`·`cafearticle`·`webkr`·`news`·`local` | ORS · 채널 판별 | **일 25,000회 합산** · `display` 최대 100 (**local은 5**) · `start` 최대 1000 | **BLOCKER 후보 (R2)** — 영업 목적 이용 가능 여부 약관 확인 선행 |
| YouTube Data API v3 | 공식 유튜브 활성도 | 10,000 units/일 | 낮음 |
| 공식 블로그 RSS (`rss.blog.naver.com`, 티스토리 등) | 발행 주기·최종 발행일 | — | 낮음 |
| 대상 업체 홈페이지 직접 fetch | **공식 판별·연락처 페이지 후보·기술 신호만** | 자체 rate limit | 중간 — robots 준수, **이메일 추출 금지** |

### 3.3 제거·미사용 소스

| 소스 | 판정 |
|---|---|
| **Google Custom Search JSON API** | **제거.** 신규 고객 차단, 기존 고객도 2027-01-01 종료 예정 ([공식 공지](https://developers.google.com/custom-search/v1/overview)). MVP에서 구글 보완 검증을 뺀다 |
| 네이버 통합검색 SERP 스크래핑 | robots.txt·약관 위반 |
| 네이버 플레이스 상세 스크래핑 | 위와 동일. 지역검색 API 공개 필드만 |
| 인스타그램·페이스북 | 약관 위반. Graph API는 소유자 인증 필요 → 링크 존재만 |
| 3rd party 업체 DB (크몽·잡코리아 등) | 약관상 재수집 금지 |
| 이메일 리스트 판매 / Hunter.io 등 파인더 | 50조의2 제2·3항 + 추측·유출 데이터 혼입 |

### 3.4 소스 레지스트리 (F-25 반영)

`source_registry` 테이블에 소스별로 **약관 URL, 수집 근거, 허용 용도, 재배포 가부, 확인일, 확인자**를 기록합니다. 어댑터는 부팅 시 자신의 레지스트리 항목이 `approved=true` 인지 확인하고, 아니면 실행을 거부합니다. robots.txt는 **운영 정책 판단 자료이지 법적 면허가 아니며**, `noindex`는 차단 사유가 아닌 별도 메타데이터로 저장합니다.

### 3.5 크롤링 정책

```
User-Agent: LeadOpsBot/1.0 (+https://<사내도메인>/bot; contact@<사내도메인>)
동시성       도메인당 1, 전역 8
요청 간격     도메인당 최소 2,000ms
타임아웃      연결 5s / 전체 15s
재시도        최대 2회, 지수 백오프(2s, 8s) + jitter
페이지 상한   업체당 최대 8 (홈·회사소개·오시는길·개인정보처리방침·이용약관·문의·제휴·footer)
응답 상한     압축 해제 후 2MB (압축 폭탄 방지)
robots.txt   캐시 24h, 조회 실패 시 fail-closed
이메일 추출   ❌ 수행하지 않음 (결론 A)
```

**SSRF 방어 (R8, P2 완료 기준) — R2-31 반영**
```
1. URL 파싱
   scheme ∈ {http, https} · port ∈ {80, 443} 만 허용
   userinfo(user:pass@) 포함 URL 거부
   숫자형/8진수/16진수 호스트 표기(2130706433, 0x7f000001, 0177.0.0.1) 거부
2. DNS 해석 → 결과 IP 전부를 검증된 IP 분류 라이브러리로 검사
   IPv4  127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8, 100.64/10,
         192.0.0/24, 192.0.2/24, 198.18/15(benchmark), 224/4(multicast), 240/4
   IPv6  ::1, ::, fc00::/7, fe80::/10, ff00::/8,
         ::ffff:0:0/96 (IPv4-mapped → 매핑 해제 후 IPv4 규칙 재적용),
         64:ff9b::/96 (NAT64 → 임베드된 IPv4 추출 후 재적용)
3. 해석된 IP로 직접 연결하고 Host 헤더 보존 → DNS rebinding 차단
4. **연결 직전 최종 peer IP 를 소켓에서 다시 읽어 2번 규칙을 재적용**
5. redirect 발생 시 1~4를 매 홉마다 재실행, 최대 3홉
6. Content-Type 허용목록 (text/html, application/xhtml+xml)
7. 압축 해제 후 크기 상한 2MB (압축 폭탄), 해제 스트림에서 초과 시 즉시 중단
8. 저장 전 HTML sanitize, 대시보드에 CSP 적용
9. http_cache 저장 전 `@` 포함 여부 검사 → 포함 시 body_excerpt 저장 거부 (R2-07)
```

---

## 4. 월 5만 원 이하 운영 구조 · 예상 비용

### 4.1 일일 API 호출 예산 (최악조건 · 캐시 0% 가정)

| 용도 | 계산 | 호출 |
|---|---|---|
| 대상 업체 ORS | 100업체 × 대표키워드 3 × 4채널 | 1,200 |
| 고득점 확장 | 30업체 × 추가키워드 5 × 4채널 | 600 |
| 플레이스 등록 확인 | 100업체 × `local` 1 | 100 |
| **경쟁사 비교** | 100업체 × 3경쟁사 × **비브랜드 대표키워드 1** × 4채널 | 1,200 |
| 공식 블로그 판별 | 100업체 × 1 | 100 |
| 소계 | | **3,200** |
| 재시도·수동 재실행 여유 | ×1.2 | **3,840** |

> v1은 4채널로 계산했지만 문서 본문에는 5종 API를 적었습니다(F-10). v2는 **ORS 채널을 4종으로 확정**하고 `local`을 분리했습니다. 경쟁사 비교를 본 업체와 동일한 3키워드로 하면 6,720회가 되므로, **비브랜드 대표 키워드 1개로 한정**합니다(비용·비교 타당성 모두).

한도 25,000회 대비 여유 **85%**. `settings.quota.naver_daily_cap` 도달 시 즉시 중단하고 실행을 `partial` 종료합니다.

| 기타 소스 | 일 호출 | 단가 | 일 소비 | 한도 |
|---|---|---|---|---|
| 공공데이터포털 | ~900 req | 1 | 900 | 개발계정 일 10,000 |
| **YouTube Data API** | **`channels.list` 100~300 req** | **1 unit** | **100~300 units** | 10,000 units |
| 홈페이지 fetch | 175업체 × 최대 8p ≈ 1,400 | — | — | 자체 rate limit |

> **v3 정정:** v2의 `~100 units×…` 는 계산되지 않은 표기였습니다. `search.list` 는 **호출당 100 units** 이므로 100개 업체를 조회하면 그것만으로 일 쿼터 10,000을 전부 소진합니다. **v3는 `search.list` 를 사용하지 않고**, 홈페이지에서 발견한 채널 URL로 **`channels.list`(1 unit)** 만 호출합니다.

### 4.2 DB 용량 (F-11 반영 — v1 설계로는 몇 주 안에 500MB 초과)

v1은 `search_results`에 원본 행을 90일 보관하려 했습니다. 실측 모델:

```
저장 대상 행 = 3,840 호출 × 30건 = 115,200 행/일
행당 크기(인덱스 포함) ≈ 510 bytes
→ 58.8 MB/일 → 90일 5.3 GB   ❌ Free 500MB의 10배
```

**v2 설계 — 원본 SERP 행을 저장하지 않는다**

| 테이블 | 저장 대상 | 보관 | 일 증가 (p50 / p95) |
|---|---|---|---|
| `search_hits` | **`is_related = true` 인 문서만** (관련률 5~15%) | 30일 | 2.9 / 8.8 MB |
| `search_aggregates` | (company, keyword, provider) 별 집계 + 분모·분류기 버전 | **파티션, 365일** | 0.4 / 0.5 MB |
| `company_observations` | 업체별 관측 스냅샷 | **파티션, 365일** | 0.2 / 0.3 MB |
| `website_/channel_observations` | 관측 이력 | 365일 | 0.3 / 0.5 MB |
| `http_cache` | 발췌 최대 4KB + 해시 | TTL 7일 | 8 / 12 MB (정상상태 56~84MB) |
| jobs·audit·cost | | 90일 | 1 / 1.5 MB |

**정상상태 용량 (p95 기준)**

| 시점 | 누적 |
|---|---|
| 30일 | 약 380 MB |
| 180일 | 약 620 MB ❗ Free 초과 |
| 365일 | 약 900 MB ❗ |

> **v3 정정:** v2의 "30일 260MB"는 관련률 하한(5%)에 가까운 값이고 영구 테이블 누적을 계산하지 않았습니다. **Supabase Free 500MB로는 6개월을 못 버팁니다.**

**대응 (P7 완료 기준)**
- `search_aggregates`·관측 테이블을 **월 단위 파티션**으로 만들고 365일 초과 파티션 detach
- 70% 도달 알람, 85% 도달 시 자동 정리 잡, 90% 도달 시 신규 실행 차단
- **180일 시점에 self-host Postgres 이전을 기정사실로 계획**합니다. Supabase Pro($25/월)로 가면 예산의 절반이 사라지므로, 워커 VPS 위 Postgres로 옮깁니다. 이를 위해 DB 접근은 Supabase JS SDK가 아닌 **표준 SQL(`postgres.js`/Drizzle)** 로 추상화하고, Auth만 Supabase에 남깁니다.

### 4.3 월 **인프라비** (최악조건 · F-30 · R2-41 반영)

> **명명 정정(v3):** 아래는 **인프라비**이며 **검수 인건비는 포함되지 않습니다.** 검수자 월 44~55시간(8.4절)은 별도 항목입니다. "월 5만 원 이하"라는 목표는 인프라비 기준으로만 성립합니다.


| 항목 | 선택 | 월(원) | 최악(원) |
|---|---|---|---|
| 워커 + 대시보드 self-host | Hetzner CX22 (2vCPU/4GB) €3.79 | 5,700 | 6,300 |
| VPS 스냅샷 백업 | €0.76 | 1,200 | 1,300 |
| DB / Auth / RLS | Supabase Free | 0 | 0 |
| **DB 덤프 오프사이트** | Cloudflare R2 (10GB 무료) | 0 | 0 |
| **모니터링·알림** | Healthchecks.io Free + Uptime Kuma self-host | 0 | 0 |
| 도메인 .kr | 연 15,000 | 1,250 | 1,300 |
| LLM (Haiku 4.5, 캐싱 적용) | 하드 상한 설정 | 8,000 | **15,000 (상한)** |
| 환율·VAT 변동 | ±10% | — | +2,400 |
| **합계** | | **약 16,200** | **약 26,300** |

**예비비 약 24,000원/월** — ORS가 표본 검증에서 실패할 경우 유료 SERP API 부분 도입 재원.

**LLM 토큰 예산 (추정 — 실측 전까지 하드 상한으로 통제)**

| 용도 | 빈도 | 입력/출력 | 캐싱 |
|---|---|---|---|
| 업종 키워드 초안 | 업종 4 × 월 1회 | 1.5k / 1.0k | 영구 캐시 |
| 검색 의도 분류 | 신규 키워드 ~500/월 | 0.3k / 0.1k | 영구 캐시 |
| 취약점·추천 문장 정리 | 100/일 × 22일 = 2,200 | 2.0k / 0.4k | 프롬프트 프리픽스 캐싱 |

`settings.cost.llm_monthly_cap_krw` 초과 시 LLM 호출 즉시 중단 → 템플릿 문장으로 폴백. 기본값 `FEATURE_LLM=off`.

**개인정보 국외이전 통제(R7):** 이메일 주소·담당자명은 LLM 프롬프트·외부 로그·에러 트래킹에 **절대 포함하지 않습니다.** 직렬화 계층에서 해당 필드를 마스킹하는 `redactPII()` 를 강제하고, 위반 시 실패하는 단위 테스트를 둡니다.

**회피 대상:** Supabase Pro($25) + Vercel Pro($20) ≈ 63,000원 → 예산 초과.

---

## 5. 시스템 아키텍처 · 데이터 흐름

### 5.1 구성 요소

```
┌──────────────────────────────────────────────────────────────┐
│ apps/web — Next.js 15 App Router (TS · Tailwind · shadcn/ui)  │
│ 검수·승인·연락처 수동 입력 · 설정 · 실행 이력                   │
│ Route Handlers = 얇은 API (Zod 검증) · CSP 적용               │
└───────────────┬──────────────────────────────────────────────┘
                │ Supabase Auth (JWT) + RLS + RPC only for writes
┌───────────────▼──────────────────────────────────────────────┐
│ Supabase PostgreSQL                                           │
│ 도메인 · jobs 큐(fencing) · settings · cost_ledger · audit    │
│ pg_cron (평일 06:00 KST) ─pg_net(HMAC)─▶ worker /internal/run │
└───────────────▲──────────────────────────────────────────────┘
                │ 표준 SQL · 워커 전용 최소권한 DB 역할 (service_role ❌)
┌───────────────┴──────────────────────────────────────────────┐
│ apps/worker — Node.js 24 + TypeScript                         │
│ 스케줄러 · 잡 워커(SKIP LOCKED + lease + fence token)          │
└───────────────┬──────────────────────────────────────────────┘
      ┌─────────┼──────────┬───────────┬──────────┐
      ▼         ▼          ▼           ▼          ▼
 SourceAdapter Search    Homepage   Channel     Scorer
 (HIRA/FTC/    Adapter   Analyzer   Analyzer    (rules)
  LocalData/   (Naver)   (+robots   (RSS/YT)
  NTS)                    +SSRF)
      └──────── HttpClient (rate limit · retry · cache · robots · SSRF guard) ────┘

  ❌ EmailExtractor — v2에서 제거 (결론 A)
  ✅ EmailVerifier  — 검수자 수동 입력 후 문법·DNS·MX 검증에만 사용
```

**자격증명 분리 (F-14)**

| 주체 | 자격증명 | 권한 |
|---|---|---|
| 브라우저 | Supabase `anon` 키 | RLS 적용 select + RPC execute만 |
| Next.js 서버 | 사용자 JWT 전달 | 사용자 권한 그대로 |
| 워커 | **전용 DB 역할 `leadops_worker`** (비밀번호, 90일 회전) | 도메인 테이블 CRUD. `auth.*`·`profiles` 접근 불가 |

`service_role` 키는 PostgREST 계층의 RLS 우회 JWT이지 DB 접속 비밀번호가 아니므로, 워커 SQL 접속에 사용하지 않습니다.

### 5.2 모노레포

```
leadops/
├─ apps/ web · worker · spike
├─ packages/ db · core · adapters · pipeline · http
├─ docs/
└─ fixtures/  goldset · http 녹화본
```
`pnpm` + `turbo`.

### 5.3 파이프라인 DAG (F-17 반영)

각 스테이지는 **선행 스테이지의 completeness 조건**을 만족해야 실행됩니다.

| # | 스테이지 | 선행 조건 | 멱등 키 | 실패 시 하류 |
|---|---|---|---|---|
| 1 | `collect` | — | `run_id+source+external_id` | 전체 중단 |
| 2 | `normalize` | 1 ≥ 90% 성공 | `dedupe_key` | 전체 중단 |
| 3 | `group` | 2 완료 | `group_key` | 경고 후 진행 |
| 4 | `exclude_basic` | 2 완료 | `company_id` | 전체 중단 |
| 5 | `homepage_detect` | 4 완료 | `run_id+company_id` | 해당 업체만 skip |
| 6 | `contact_pages` | 5 = confirmed\|likely | `website_id` | 해당 업체 skip |
| 7 | `channel_analyze` | 5 완료 | `run_id+company_id` | `unavailable` 기록 후 진행 |
| 8 | `search_analyze` | 5 완료 | `run_id+company_id+keyword` | 해당 업체 skip |
| 9 | `competitor_select` | 4 완료 | `run_id+company_id` | 해당 업체 `competitor unavailable` |
| 10 | `competitor_analyze` | 9 완료 | `competitor_id` | 유효 경쟁사 <2 면 격차 축 `unavailable` |
| 11 | `score` | 7·8·10 terminal | `run_id+company_id` | 해당 업체 skip |
| 12 | `recommend` | 11 완료 | `score_id` | 템플릿 폴백 |
| 13 | `shortlist` | 11 ≥ 80% terminal | `run_id` | run `failed` |

**게이트 위치:** 4→5 (기본 통과 150~200) · 11→13 (3축 임계값 + 취약점 조건) · **검수 승인 시점 (연락처·MX)**

**재실행 규칙 (R2-21):** 특정 스테이지부터 재실행하면 **새 `run_attempts` 행**을 만들고, 이전 attempt의 하류 결과에 `invalidated_at` 을 찍습니다. **모든 관측·결과 테이블의 유일키에 `attempt_id` 가 포함**되므로 새 결과가 기존 행과 충돌하지 않습니다(v2는 유일키에 attempt가 없어 재실행이 물리적으로 불가능했습니다). `scores` 는 참조한 모든 관측 버전을 `score_inputs` 로 고정하므로 과거 점수가 그대로 재현됩니다(F-19 · R2-23).

**`partial` 집계 SQL**
```sql
-- stage terminal 판정
status = case
  when failed = 0 and done = total then 'succeeded'
  when done + failed = total and done >= total * 0.8 then 'partial'
  when done + failed = total then 'failed'
  else 'running' end
-- run 상태 = 스테이지 상태의 최악값 (failed > partial > succeeded)
```

### 5.4 하루 흐름

```
06:00 pg_cron ─HMAC─▶ worker : runs(queued) 생성
  ├─ 1~4   신규 70% + 재평가 30% 후보 → 기본 통과 150~200
  ├─ 5~6   홈페이지 판별 → 연락처 페이지 URL 후보 기록 (이메일 추출 ❌)
  ├─ 7~10  채널·ORS·경쟁사 (네이버 쿼터 감시)
  ├─ 11~13 3축 점수 → 업종 60% 상한 적용 → 검수 후보 ≤100
  └─ runs.status = succeeded | partial | failed

검수자 (업무 시간)
  후보 확인 → 승인 의사 → 연락처 페이지 열람 → 이메일 수동 입력
    → 문법·DNS·MX 자동 검증 → 통과 시 승인 확정 → leads (점수순 ≤50, 업종 60% 재적용)
  → 미승인/제외 업체는 cooldown 설정 후 재평가 풀로 복귀
```

---

## 6. ERD · 주요 테이블 · RLS

### 6.1 v1 대비 스키마 변경 요약

| 변경 | 이유 |
|---|---|
| `emails` 재설계 + `email_occurrences` 분리, `acquisition_method` 필수 | F-01 · F-16 |
| `contact_pages` 신설 (이메일 문자열 미저장) | F-01 |
| `websites` → `website_observations` 분리 | F-19 |
| `channels` → `channel_observations` 분리 | F-19 |
| `search_results` 삭제 → `search_hits`(관련 문서만) + `search_aggregates` | F-11 |
| `company_observations`·cooldown 컬럼 신설 | F-06 |
| `source_registry` 신설 | F-25 |
| `do_not_contact`·`opt_out_at`·`retention_until` | F-07 · F-08 |
| `jobs`에 `lease_expires_at`·`fence_token`·`heartbeat_at` | F-15 |
| `runs` 부분 유일 인덱스, 복합 FK, canonical URL, 경쟁사 유일성 | F-18 |
| `cost_ledger`·`outbox` 이벤트 유일키 | F-16 |
| `CREATE EXTENSION citext` 명시 | F-32 |

**v3 추가 변경**

| 변경 | 이유 |
|---|---|
| **`run_attempts` 1급 엔터티화** — `run_stages`·`jobs`·모든 관측·결과 유일키를 `run_id` → `attempt_id` 로 | R2-21 (v2 유일키로는 재실행이 물리적으로 불가능) |
| `collection_legal_basis`(수집) / `contact_legal_basis`(접촉) 분리, 둘 다 NOT NULL | R2-03 |
| `approval_counters` 를 `(approval_date, industry)` PK로 재설계 | R2-18 |
| `scores` 에 `unique(id, run_id, company_id)` + `review_items` 단일 복합 FK | R2-22 |
| `score_inputs` 연결 테이블 + `rule_version`·`classifier_version` | R2-23 |
| `contact_pages.body_fetched` CHECK 제약 (본문 fetch 금지를 DB가 강제) | R2-07 |
| `emails.source_contact_page_id`·`entered_at` 결속, `is_personal_data`·`retention_until` NOT NULL | R2-08 · R2-26 |
| `privacy_requests` 테이블 신설 | R2-26 |
| `search_hits` 채널 간 중복 제거 유일키 + `collected_at` 인덱스, `search_aggregates.all_url_hashes` | R2-09 · R2-14 |
| `source_registry.written_approval_ref` | R2-02 |
| `leads.use_scope`·`export_count` | R2-32 · S-02 |
| `company_observations.change_detected`·`track` | 결론 D |
| `create schema if not exists extensions` + `extensions.citext` 수식 | R2-34 |

### 6.2 주요 DDL

```sql
-- R2-34: 스키마 생성 선행 + 완전 수식 타입 사용
create schema if not exists extensions;
create extension if not exists citext   with schema extensions;
create extension if not exists pgcrypto with schema extensions;
-- 이하 citext 컬럼은 전부 extensions.citext 로 수식한다

-- ── 권한
create type user_role as enum ('admin','user');

-- ── R2-03: 수집 근거와 접촉 근거를 분리한다
create type collection_basis as enum
  ('public_api_field','manual_from_public_site','provided_by_subject');
create type contact_basis as enum
  ('pending_legal_review','explicit_consent','existing_transaction_6m',
   'legitimate_interest_claimed','not_permitted');
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null, role user_role not null default 'user',
  created_at timestamptz not null default now()
);

-- ── 소스 레지스트리 (F-25)
create table source_registry (
  source text primary key,
  terms_url text, legal_basis text not null, allowed_use text not null,
  redistribution_allowed boolean not null default false,
  approved boolean not null default false,
  written_approval_ref text,          -- R2-02: 서면 허용 근거(메일 ID·문서번호). 없으면 ORS 비활성
  reviewed_by text, reviewed_at date, note text
);

-- ── 실행
create type run_status as enum ('queued','running','paused','succeeded','partial','failed','cancelled');
create table runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null, trigger text not null,
  attempt int not null default 1,
  status run_status not null default 'queued',
  settings_snapshot jsonb not null,
  counts jsonb not null default '{}', cost_krw numeric(10,2) not null default 0,
  error text, started_at timestamptz, finished_at timestamptz,
  created_at timestamptz not null default now()
);
-- F-18: created_at 포함 유일키는 중복 cron을 못 막음 → 부분 유일 인덱스
create unique index runs_one_cron_per_day
  on runs (run_date) where trigger = 'cron';

-- ── R2-21: 실행 시도를 1급 엔터티로. 모든 관측·결과 유일키에 attempt_id 포함
--    ❗ runs 를 참조하므로 반드시 runs 다음에 생성한다 (v3 첫 편집의 순서 오류 수정)
create table run_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  attempt_no int not null,
  from_stage text,                     -- 부분 재실행 시작 지점
  created_at timestamptz not null default now(),
  unique (run_id, attempt_no),
  unique (id, run_id)                  -- 하위 테이블의 (attempt_id, run_id) 복합 FK 대상
);

create type stage_status as enum ('pending','running','succeeded','partial','failed','skipped');
create table run_stages (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references run_attempts(id) on delete cascade,   -- R2-21
  stage text not null, status stage_status not null default 'pending',
  total int not null default 0, done int not null default 0, failed int not null default 0,
  started_at timestamptz, finished_at timestamptz,
  unique (attempt_id, stage)
);

-- ── 잡 큐 (F-15: lease + fencing token)
create type job_status as enum ('queued','running','succeeded','failed','dead','cancelled');
create table jobs (
  id bigserial primary key,
  attempt_id uuid not null references run_attempts(id) on delete cascade,   -- R2-21
  stage text not null, idempotency_key text not null, payload jsonb not null,
  status job_status not null default 'queued',
  attempts int not null default 0, max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_by text, locked_at timestamptz,
  lease_expires_at timestamptz, heartbeat_at timestamptz,
  fence_token bigint not null default 0,
  last_error text, created_at timestamptz not null default now(),
  unique (attempt_id, stage, idempotency_key)
);
create index jobs_ready on jobs (run_after) where status = 'queued';
create index jobs_expired on jobs (lease_expires_at) where status = 'running';

-- ── 업체 (F-06 재검색)
create type company_status as enum ('active','suspended','closed','unknown');
create table company_groups (
  id uuid primary key default gen_random_uuid(),
  group_key text unique not null, kind text not null, display_name text not null
);
create table companies (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references company_groups(id),
  dedupe_key text unique not null,
  name text not null, normalized_name text not null,
  industry text not null, biz_no text, corp_no text,
  region_sido text, region_sigungu text, region_dong text,
  address text, phone text, lat numeric, lng numeric,
  status company_status not null default 'unknown', status_source text, closed_at date,
  size_tier text, size_signals jsonb not null default '{}',
  is_headquarters boolean not null default false,
  excluded_reason text,
  -- 재검색 제어
  last_scanned_at timestamptz, next_eligible_at timestamptz, scan_count int not null default 0,
  content_fingerprint text,           -- 변경 탐지용
  do_not_contact boolean not null default false, opt_out_at timestamptz,
  retention_until date,                -- F-08 보유기간
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index companies_eligible on companies (next_eligible_at)
  where excluded_reason is null and do_not_contact = false;

create table company_observations (      -- F-06 · F-19 · R2-21 (365일 파티션)
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  observed_at timestamptz not null default now(),
  status company_status not null, content_fingerprint text,
  change_detected boolean not null default false,   -- 결론 D: 재평가 촉발 신호
  track text not null,                              -- 'new' | 'changed' | 'recontact'
  summary jsonb not null default '{}',
  unique (company_id, attempt_id)
);

-- ── 홈페이지 (F-19 관측 분리, F-18 canonical)
create type official_status as enum ('confirmed','likely','uncertain','not_official','unavailable');
create table websites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  canonical_url text not null,        -- 정규화: scheme+host 소문자, www 제거, 후행 / 제거
  domain text not null,
  unique (company_id, canonical_url)
);
create table website_observations (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references websites(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,   -- R2-21
  observed_at timestamptz not null default now(),
  official_status official_status not null, official_score numeric(5,2),
  signals jsonb not null default '{}',
  robots_allowed boolean, has_noindex boolean,      -- F-25: noindex는 차단사유 아님
  has_contact_form_only boolean, http_status int,
  tech_signals jsonb not null default '{}', crawled_pages int not null default 0,
  content_hash text,
  unique (website_id, attempt_id)
);

-- 연락처 페이지 후보 (결론 A · R2-07)
-- ❗ 이메일 문자열을 저장하지 않을 뿐 아니라, 이 URL의 **본문을 fetch·캐시하지 않는다.**
--   탐지는 상위 페이지의 링크 URL·앵커 텍스트만으로 수행한다.
--   본문은 검수자의 브라우저만 가져온다. (방어선을 스스로 흐리지 않기 위함)
create table contact_pages (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references websites(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  url text not null,
  page_kind text not null,            -- 'contact'|'about'|'privacy'|'terms'|'footer'|'partnership'
  link_text text, confidence numeric(4,3),
  body_fetched boolean not null default false
    constraint contact_body_never_fetched check (body_fetched = false),
  unique (website_id, attempt_id, url)
);

-- ── 이메일 (수동 입력 또는 공공 API 필드만)
create type email_type as enum ('representative','inquiry','partnership','marketing','business_info','staff','unknown');
create type acquisition_method as enum ('manual_entry','public_api');   -- 'scraped' 없음
create table emails (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  address extensions.citext not null,
  local_part text not null, domain text not null,
  email_type email_type not null default 'unknown',
  acquisition_method acquisition_method not null,
  collection_legal_basis collection_basis not null,        -- R2-03 (NOT NULL)
  entered_by uuid references profiles(id),      -- manual_entry 시 필수
  entered_at timestamptz,
  source_contact_page_id uuid references contact_pages(id),-- R2-08: 실제로 본 페이지와 결속
  source_api text,                              -- public_api 시 소스명
  domain_match boolean not null default false, is_free_mail boolean not null default false,
  syntax_ok boolean, dns_ok boolean, mx_ok boolean, mx_hosts text[], verified_at timestamptz,
  confidence numeric(4,3),
  is_personal_data boolean not null,            -- R2-26 (NOT NULL, 판정 강제)
  retention_until date not null,                -- R2-26 (NOT NULL)
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, address),
  constraint manual_needs_actor check (
    acquisition_method <> 'manual_entry'
    or (entered_by is not null and entered_at is not null and source_contact_page_id is not null)),
  constraint api_needs_source   check (acquisition_method <> 'public_api' or source_api is not null)
);
create table email_occurrences (      -- F-16: provenance 보존
  id bigserial primary key,
  email_id uuid not null references emails(id) on delete cascade,
  found_url text not null, found_location text, observed_at timestamptz not null default now(),
  unique (email_id, found_url)
);

-- ── 검색 (F-11)
create type channel_type as enum
  ('official_site','official_blog','official_video','official_sns','place','news',
   'thirdparty_blog','cafe','community','review','webdoc','unknown');
create type recency_bucket as enum ('d0_60','d61_120','d120_plus','unknown');

create table search_aggregates (       -- 365일 파티션 (R2-13)
  id bigserial primary key,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  keyword text not null, keyword_kind text not null,   -- 'brand'|'nonbrand'
  provider text not null,                              -- naver_blog|naver_cafe|naver_web|naver_news
  total_returned int not null,
  denominator int not null,                            -- R2-09: min(30, total_returned)
  related_count int not null, official_count int not null,
  recency_dist jsonb not null default '{}',
  all_url_hashes text[] not null,                      -- R2-14: 음성 결과도 감사 가능하게 해시만 보존
  classifier_version text not null,                    -- R2-14: 분류 오류 사후 감사
  ors numeric(5,4),                                    -- related / denominator
  collected_at timestamptz not null default now(),
  unique (attempt_id, company_id, keyword, provider)   -- F-16 멱등
);
create table search_hits (             -- is_related = true 만, 30일 보관
  id bigserial primary key,
  aggregate_id bigint not null references search_aggregates(id) on delete cascade,
  -- R2-09: 채널 간 중복 제거를 위해 상위 키를 비정규화해서 보유
  attempt_id uuid not null, company_id uuid not null, keyword text not null,
  rank int not null, channel_type channel_type not null,
  is_official boolean not null default false,
  url text not null, url_hash text not null, title text,
  published_at date, recency recency_bucket not null default 'unknown',
  collected_at timestamptz not null default now(),
  unique (attempt_id, company_id, keyword, url_hash)   -- ✅ 채널(provider) 간 중복 제거
);
create index search_hits_cleanup on search_hits (collected_at);   -- R2-14: 30일 정리용

-- ── 공식 채널
create table channels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  type channel_type not null, url text not null,
  unique (company_id, type, url)
);
create table channel_observations (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,   -- R2-21
  is_active boolean, last_post_at date,
  posts_60d int, posts_120d int, cadence_days numeric(6,2),
  content_mix jsonb not null default '{}',
  analyzable boolean not null default true, unavailable_reason text,
  observed_at timestamptz not null default now(),
  unique (channel_id, attempt_id)
);

-- ── 경쟁사 (F-18 · F-23)
create table competitors (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references run_attempts(id) on delete cascade,   -- R2-21
  company_id uuid not null references companies(id) on delete cascade,
  competitor_company_id uuid references companies(id),
  competitor_name text not null, competitor_url text,
  selection_method text not null, similarity jsonb not null default '{}',
  rank int not null,
  is_valid boolean not null default false,        -- 분석 성공 여부
  unique (attempt_id, company_id, rank),
  unique (attempt_id, company_id, competitor_company_id)   -- 같은 경쟁사 중복 금지
);
create table competitor_metrics (
  competitor_id uuid primary key references competitors(id) on delete cascade,
  ors numeric(5,4), official_assets int, thirdparty_assets int,
  diversity int, recency_60d int, nonbrand_exposure int, channel_activity numeric(5,2),
  raw jsonb not null default '{}'
);

-- ── 점수 (F-21 3축)
create table scores (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  attempt_id uuid not null references run_attempts(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  axis_problem numeric(5,2) not null,        -- 0~60
  axis_propensity numeric(5,2) not null,     -- 0~25
  axis_confidence numeric(5,2) not null,     -- 0~15
  total numeric(5,2) not null,
  breakdown jsonb not null, weaknesses jsonb not null,
  competitor_gap_available boolean not null default false,   -- F-23
  ors_scored boolean not null default false,                 -- R2-02: ORS 배점 반영 여부
  rule_version text not null,                                -- R2-23
  gate_passed boolean not null, gate_reason text,
  invalidated_at timestamptz,
  unique (attempt_id, company_id),
  unique (id, attempt_id, company_id),       -- R2-22: review_items 복합 FK의 대상
  -- attempt 가 실제로 그 run 소속인지 DB가 보장 (v3 지적 반영)
  foreign key (attempt_id, run_id) references run_attempts (id, run_id) on delete cascade
);

-- R2-23: 점수가 참조한 모든 관측 버전을 고정한다 (observation_id 하나로는 부족)
create table score_inputs (
  score_id uuid not null references scores(id) on delete cascade,
  input_kind text not null,        -- 'company_obs'|'website_obs'|'channel_obs'|'search_agg'|'competitor'
  input_id text not null,
  primary key (score_id, input_kind, input_id)
);
create table recommendations (
  score_id uuid primary key references scores(id) on delete cascade,
  primary_service text not null, secondary_services text[] not null default '{}',
  rationale text, rationale_source text not null default 'rule'
);

-- ── 검수 / 리드
create type review_status as enum ('pending','approved','rejected');
create table review_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  attempt_id uuid not null,                       -- R2-21: 재실행 시 새 attempt 로 재생성 가능
  company_id uuid not null references companies(id) on delete cascade,
  score_id uuid not null,
  rank int not null, status review_status not null default 'pending',
  decided_by uuid references profiles(id), decided_at timestamptz,
  reject_reason text, note text,
  unique (attempt_id, company_id),
  -- R2-22: score_id 와 attempt/company 를 하나의 복합 FK로 결속
  foreign key (score_id, attempt_id, company_id)
    references scores (id, attempt_id, company_id) on delete cascade,
  foreign key (attempt_id, run_id) references run_attempts (id, run_id) on delete cascade
);
-- 같은 run 안에서 한 업체가 두 attempt 에 걸쳐 동시에 pending 이 되지 않게 한다
create unique index review_items_one_open_per_run
  on review_items (run_id, company_id) where status = 'pending';

-- R2-18: 카운터를 run 이 아니라 **승인일** 기준으로. 수동 run 추가로 상한 우회 불가
-- ❗ 일 총량과 업종별 카운터를 분리한다. 업종 행만 잠그면 서로 다른 업종의 동시 승인이
--    같은 총합을 읽고 함께 통과해 상한을 넘길 수 있다 (v3 지적 반영)
create table approval_day_totals (
  approval_date date primary key,
  approved_total int not null default 0
);
create table approval_counters (
  approval_date date not null references approval_day_totals(approval_date) on delete cascade,
  industry text not null,
  approved_count int not null default 0,
  primary key (approval_date, industry)
);

-- R2-08: 검수 화면을 실제로 연 세션만 이메일을 입력할 수 있게 하는 1회용 nonce
create table review_view_nonces (
  nonce text primary key,
  review_item_id uuid not null references review_items(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index review_view_nonces_gc on review_view_nonces (expires_at);

create table leads (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  company_id uuid not null references companies(id),
  review_item_id uuid not null references review_items(id),
  email_id uuid not null references emails(id),
  score numeric(5,2) not null, snapshot jsonb not null,
  contact_legal_basis contact_basis not null default 'pending_legal_review',  -- R2-03
  contact_basis_set_by uuid references profiles(id), contact_basis_note text,
  use_scope text not null default 'internal_only',   -- R2-32: 대외 반출 통제
  retention_until date not null,
  export_status text not null default 'none', external_crm_id text, exported_at timestamptz,
  export_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (company_id, run_id)          -- F-06: 영구 차단이 아니라 run 단위
);

-- R2-26: 개인정보 권리 요청 처리 증적
create table privacy_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                 -- 'access'|'delete'|'suspend'|'correct'
  subject_identifier text not null,   -- 이메일 또는 업체 식별자
  company_id uuid references companies(id),
  status text not null default 'received',  -- received|in_progress|on_hold|completed|rejected
  hold_reason text, legal_hold boolean not null default false,
  received_at timestamptz not null default now(),
  due_at timestamptz not null,
  completed_at timestamptz, completed_by uuid references profiles(id),
  actions_taken jsonb not null default '[]',
  evidence jsonb not null default '{}'
);
create table outbox (
  id bigserial primary key,
  event_key text not null unique,      -- F-16 멱등
  topic text not null, payload jsonb not null,
  published_at timestamptz, created_at timestamptz not null default now()
);

-- ── 운영
create table settings (
  key text primary key, value jsonb not null,
  updated_by uuid references profiles(id), updated_at timestamptz not null default now()
);
create table cost_ledger (
  id bigserial primary key,
  run_id uuid references runs(id) on delete cascade,
  entry_key text not null unique,      -- F-16 멱등: run_id+provider+stage+bucket
  provider text not null, unit text not null,
  qty numeric(12,2) not null, krw numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);
create table http_cache (
  cache_key text primary key, status int, headers jsonb,
  body_hash text, body_excerpt text,   -- 최대 4KB
  fetched_at timestamptz not null, expires_at timestamptz not null
);
create table audit_log (
  id bigserial primary key, actor uuid references profiles(id),
  action text not null, entity text not null, entity_id text,
  before jsonb, after jsonb, ip inet, created_at timestamptz not null default now()
);
```

### 6.3 RLS (F-12 · F-13 · F-14 반영)

**v1의 치명적 결함:** `review_decide` 정책의 `WITH CHECK (true)` 는 인증된 일반 사용자가 PostgREST로 직접 `PATCH /review_items?id=eq.X` 를 호출해 `status`·`score_id`·`rank`·`decided_by` 등 **모든 컬럼을 임의로 변경**하고 승인 상한·업종 비율 검사를 완전히 우회하게 만듭니다. "UI는 RPC만 호출한다"는 약속은 통제 수단이 아닙니다.

**v2 원칙: 인증 사용자에게 어떤 테이블의 `INSERT`/`UPDATE`/`DELETE` 정책도 부여하지 않는다. 모든 쓰기는 `SECURITY DEFINER` RPC를 통한다.**

```sql
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;
revoke execute on function public.is_admin() from public;
grant   execute on function public.is_admin() to authenticated;

-- 읽기 전용 정책 (전 도메인 테이블 공통 패턴)
alter table public.companies enable row level security;
create policy companies_read on public.companies for select to authenticated using (true);
-- ❗ insert/update/delete 정책 없음 → authenticated 는 쓰기 불가

alter table public.review_items enable row level security;
create policy review_read on public.review_items for select to authenticated using (true);
-- ❗ v1의 review_decide UPDATE 정책 삭제

alter table public.leads enable row level security;
create policy leads_read on public.leads for select to authenticated using (true);

alter table public.settings enable row level security;
create policy settings_read on public.settings for select to authenticated using (true);

-- 민감 테이블은 admin 만 읽기
alter table public.audit_log  enable row level security;
alter table public.cost_ledger enable row level security;
alter table public.jobs        enable row level security;
create policy audit_admin on public.audit_log  for select to authenticated using (public.is_admin());
create policy cost_admin  on public.cost_ledger for select to authenticated using (public.is_admin());
create policy jobs_admin  on public.jobs        for select to authenticated using (public.is_admin());

alter table public.profiles enable row level security;
create policy profiles_self on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
```

**⚠️ v2 승인 RPC의 버그 4개 (v3에서 수정)**

| # | v2 코드 | 실제 동작 |
|---|---|---|
| R2-01 | `(cnt+1)/(total+1) > share_max` | 첫 승인 시 `1/1 = 1.0 > 0.6` → **모든 업종의 첫 건이 항상 거부됨. 승인 기능 전체가 동작 불능** |
| R2-17 | `on conflict (company_id, run_id) do nothing` | score 조회가 0행이거나 충돌해도 검수 상태·카운터는 승인된 채 `{ok:true}` 반환 → **실패를 성공으로 위장** |
| R2-18 | 카운터가 `run_id` 기준 | 관리자가 수동 run을 하나 더 만들면 **같은 날 50건씩 추가 승인 가능** |
| R2-19 | `v_cap := (select ...)` 가 NULL이면 | `v_counter.approved_total >= NULL` → NULL → IF false → **상한 검사가 fail-open** |

**v3 — 승인 RPC**

```sql
create or replace function public.decide_review_item(
  p_item_id uuid, p_status review_status,
  p_reason text default null, p_email_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_item review_items%rowtype;
  v_settings jsonb; v_industry text;
  v_cap int; v_share_max numeric; v_industry_quota int; v_industry_cnt int; v_day_total int;
  v_cooldown_days int; v_retention_days int; v_score scores%rowtype; v_rows int;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '28000'; end if;
  -- R2-16: 허용 전이를 명시적으로 제한 (pending 재설정·approved→approved 방지)
  if p_status not in ('approved','rejected') then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  select * into v_item from review_items where id = p_item_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  -- R2-16: 재판정은 revoke_approval() 로만. 여기서는 pending 만 허용 (관리자도 예외 없음)
  if v_item.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;

  -- R2-19: 설정은 run 의 동결 스냅샷에서 STRICT 로 읽는다 (누락 시 fail-closed)
  select settings_snapshot into strict v_settings from runs where id = v_item.run_id;
  v_cap            := (v_settings #>> '{targets,final_max}')::int;
  v_share_max      := (v_settings #>> '{targets,industry_share_max}')::numeric;
  v_cooldown_days  := (v_settings #>> '{targets,cooldown_rejected_days}')::int;
  v_retention_days := (v_settings #>> '{privacy,lead_retention_days}')::int;
  if v_cap is null or v_share_max is null
     or v_cooldown_days is null or v_retention_days is null
     or v_cap <= 0 or v_share_max <= 0 or v_share_max > 1 then
    raise exception 'configuration_error' using errcode = '22023';
  end if;

  select industry into strict v_industry from companies where id = v_item.company_id;

  if p_status = 'approved' then
    if p_email_id is null then raise exception 'email_required' using errcode = '22023'; end if;
    perform 1 from emails e
      where e.id = p_email_id and e.company_id = v_item.company_id and e.mx_ok is true;
    if not found then raise exception 'email_not_verified' using errcode = '22023'; end if;

    -- R2-18: 카운터를 승인일 기준으로. R2-01: 순서 독립적 절대 쿼터
    -- ❗ 잠금 순서 고정: (1) 일 총량 행 → (2) 업종 행. 항상 같은 순서라 교착이 없다
    v_industry_quota := floor(v_cap * v_share_max);          -- 50 × 0.6 = 30

    insert into approval_day_totals (approval_date) values (current_date)
      on conflict (approval_date) do nothing;
    select approved_total into strict v_day_total
      from approval_day_totals where approval_date = current_date
       for update;                                            -- 직렬화 지점 (1)
    if v_day_total >= v_cap then
      raise exception 'daily_cap_reached' using errcode = '55000';
    end if;

    insert into approval_counters (approval_date, industry)
      values (current_date, v_industry)
      on conflict (approval_date, industry) do nothing;
    select approved_count into strict v_industry_cnt
      from approval_counters
     where approval_date = current_date and industry = v_industry
       for update;                                            -- 직렬화 지점 (2)
    if v_industry_cnt + 1 > v_industry_quota then
      raise exception 'industry_quota_exceeded' using errcode = '55000';
    end if;

    select * into strict v_score from scores where id = v_item.score_id;

    -- R2-17: ON CONFLICT 제거 + 정확히 1행 확인, 아니면 전체 트랜잭션 실패
    insert into leads (run_id, company_id, review_item_id, email_id, score, snapshot,
                       contact_legal_basis, retention_until)
    values (v_item.run_id, v_item.company_id, v_item.id, p_email_id, v_score.total,
            jsonb_build_object('score', to_jsonb(v_score), 'decided_at', now()),
            'pending_legal_review',                            -- R2-03: 접촉 근거는 별도 결정
            current_date + v_retention_days);
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'lead_insert_failed' using errcode = '55000'; end if;

    update approval_counters set approved_count = approved_count + 1
     where approval_date = current_date and industry = v_industry;
    update approval_day_totals set approved_total = approved_total + 1
     where approval_date = current_date;
  else
    update companies
       set next_eligible_at = now() + make_interval(days => v_cooldown_days)
     where id = v_item.company_id;
  end if;

  update review_items
     set status = p_status, decided_by = auth.uid(),
         decided_at = now(), reject_reason = p_reason
   where id = p_item_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'review.decide', 'review_items', p_item_id::text,
          jsonb_build_object('status', p_status, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'status', p_status);
end $$;
```

**v3 — 연락처 수동 입력 RPC (R2-08)**

v2는 이 함수를 언급만 하고 본문을 쓰지 않았습니다. `acquisition_method='manual_entry'` 는 **호출자가 고른 라벨일 뿐 사람이 취득했다는 증거가 아니므로**, 함수가 행위자·대상 페이지·시각을 결속하고 자동화된 대량 호출을 막아야 합니다.

```sql
create or replace function public.enter_contact_email(
  p_review_item_id uuid, p_address text, p_email_type email_type,
  p_contact_page_id uuid, p_nonce text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_item review_items%rowtype; v_page contact_pages%rowtype;
  v_domain text; v_local text; v_recent int; v_email_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '28000'; end if;

  -- 1) UI 세션 nonce 검증 — 화면을 열지 않은 대량 호출 차단
  perform 1 from review_view_nonces
   where nonce = p_nonce and review_item_id = p_review_item_id
     and user_id = auth.uid() and used_at is null and expires_at > now();
  if not found then raise exception 'invalid_nonce' using errcode = '28000'; end if;
  update review_view_nonces set used_at = now() where nonce = p_nonce;

  -- 2) 사용자당 rate limit — 사람이 페이지를 읽는 속도의 상한
  select count(*) into v_recent from emails
   where entered_by = auth.uid() and entered_at > now() - interval '1 minute';
  if v_recent >= 3 then raise exception 'rate_limited' using errcode = '53400'; end if;

  select * into strict v_item from review_items where id = p_review_item_id;
  select * into strict v_page from contact_pages where id = p_contact_page_id;

  -- 3) 연락처 페이지가 이 업체의 것인지 확인
  perform 1 from websites w
   where w.id = v_page.website_id and w.company_id = v_item.company_id;
  if not found then raise exception 'page_company_mismatch' using errcode = '22023'; end if;

  -- 4) 문법 검증 (DNS·MX 는 워커가 비동기 수행)
  if p_address !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_syntax' using errcode = '22023';
  end if;
  v_local  := split_part(p_address, '@', 1);
  v_domain := lower(split_part(p_address, '@', 2));

  insert into emails (company_id, address, local_part, domain, email_type,
                      acquisition_method, collection_legal_basis,
                      entered_by, entered_at, source_contact_page_id,
                      domain_match, is_free_mail, syntax_ok,
                      is_personal_data, retention_until)
  values (v_item.company_id, p_address, v_local, v_domain, p_email_type,
          'manual_entry', 'manual_from_public_site',
          auth.uid(), now(), p_contact_page_id,
          exists (select 1 from websites w
                   where w.company_id = v_item.company_id and w.domain = v_domain),
          v_domain = any (array['gmail.com','naver.com','daum.net','hanmail.net','nate.com']),
          true,
          p_email_type = 'staff',                    -- 담당자 주소는 개인정보로 판정
          current_date + 365)
  -- ❗ 충돌 시에도 현재 행위자·페이지·시각을 다시 결속한다.
  --    (라벨만 남고 증거가 갱신되지 않으면 manual_entry 주장이 검증 불가능해짐)
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
end $$;
```

**v3 — 승인 취소 (R2-16 보상 트랜잭션)**

```sql
create or replace function public.revoke_approval(p_item_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item review_items%rowtype; v_industry text;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into strict v_item from review_items where id = p_item_id for update;
  if v_item.status <> 'approved' then raise exception 'not_approved' using errcode = '55000'; end if;

  select industry into strict v_industry from companies where id = v_item.company_id;
  delete from leads where review_item_id = p_item_id;
  update approval_day_totals set approved_total = greatest(approved_total - 1, 0)
   where approval_date = v_item.decided_at::date;
  update approval_counters set approved_count = greatest(approved_count - 1, 0)
   where approval_date = v_item.decided_at::date and industry = v_industry;
  update review_items set status = 'rejected', reject_reason = p_reason,
                          decided_by = auth.uid(), decided_at = now()
   where id = p_item_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'review.revoke', 'review_items', p_item_id::text,
          jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;
```

**v3 — export 게이트 (R2-03: 선언이 아니라 SQL로 강제)**

"접촉 근거 없는 리드는 export 제외"는 문장으로만 있으면 통제가 아닙니다. export 경로를 함수 하나로 좁히고 조건을 그 안에 넣습니다.

```sql
create or replace function public.export_leads(p_from date, p_to date)
returns setof jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_row record; v_watermark jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_watermark := jsonb_build_object(
    'exported_by', auth.uid(), 'exported_at', now(), 'range', jsonb_build_array(p_from, p_to));

  for v_row in
    select l.*, c.name, c.industry, e.address
      from leads l
      join companies c on c.id = l.company_id
      join emails    e on e.id = l.email_id
     where l.created_at::date between p_from and p_to
       -- ❗ 접촉 근거 하드 게이트
       and l.contact_legal_basis in ('explicit_consent','existing_transaction_6m')
       and l.use_scope = 'internal_only'          -- R2-32
       and c.do_not_contact = false
       and c.opt_out_at is null
       and (l.retention_until is null or l.retention_until >= current_date)
       and e.mx_ok is true
       and not exists (select 1 from privacy_requests pr
                        where pr.company_id = l.company_id
                          and pr.status in ('received','in_progress','on_hold'))
     order by l.score desc
  loop
    update leads set export_status = 'exported', exported_at = now(),
                     export_count = export_count + 1
     where id = v_row.id;
    if v_row.export_count >= 3 then                -- S-02 다운로드 횟수 제한
      raise exception 'export_limit_exceeded' using errcode = '55000';
    end if;
    return next to_jsonb(v_row) || jsonb_build_object('_watermark', v_watermark);
  end loop;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'leads.export', 'leads', null, v_watermark);
end $$;
```

> `contact_legal_basis` 의 기본값이 `pending_legal_review` 이므로 **법률 의견서가 나오기 전까지는 export 결과가 0행입니다.** 이것은 버그가 아니라 의도된 fail-closed 동작이며, 승인 전 질문 1의 답이 나오면 admin이 `set_contact_basis()` 로 근거를 설정합니다.

**함수 권한 (전 함수 공통)**

```sql
revoke execute on function public.decide_review_item(uuid, review_status, text, uuid) from public;
revoke execute on function public.enter_contact_email(uuid, text, email_type, uuid, text) from public;
revoke execute on function public.revoke_approval(uuid, text) from public;
grant  execute on function public.decide_review_item(uuid, review_status, text, uuid) to authenticated;
grant  execute on function public.enter_contact_email(uuid, text, email_type, uuid, text) to authenticated;
grant  execute on function public.revoke_approval(uuid, text) to authenticated;  -- 내부에서 admin 검사
```

동일 패턴으로 `update_setting(key, value)`(admin), `approve_keyword(id)`(admin), `set_contact_basis(lead_id, basis, note)`(admin) 을 둡니다.

**RLS 전수 검증 (R2-20)**

v2는 "모든 쓰기는 RPC만"이라고 선언했지만 `emails`·`contact_pages`·`approval_counters` 등에는 RLS enable·정책·grant 가 아예 없었습니다. 선언은 통제가 아닙니다.

```sql
-- P1 완료 기준: 아래 쿼리가 0행이어야 한다
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false;

-- P1 완료 기준: authenticated 에 대한 INSERT/UPDATE/DELETE 정책이 0개여야 한다
select polname, polrelid::regclass from pg_policy
 where polcmd in ('a','w','d') and 'authenticated' = any (
   select rolname from pg_roles where oid = any (polroles));

-- P1 완료 기준: security definer 함수 중 search_path 미고정 또는 PUBLIC 실행권 보유가 0개
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and (p.proconfig is null or not ('search_path=public, pg_temp' = any(p.proconfig))
        or has_function_privilege('public', p.oid, 'execute'));
```

`approval_counters` 는 `authenticated` 에 **select 정책도 부여하지 않습니다**(완전 비공개, RPC 내부에서만 접근).

---

## 7. API · 작업 상태 모델

### 7.1 상태 모델

```
run    queued → running → { succeeded | partial | failed | cancelled }   (↕ paused)
stage  pending → running → { succeeded | partial | failed | skipped }
job    queued → running → { succeeded | failed(재시도) | dead | cancelled }
```

**잡 획득 — 원자적 UPDATE ... RETURNING + fencing token (F-15)**

v1의 "10분 reaper"는 느린 정상 잡을 중복 실행시킵니다. `locked_at`이 오래됐다는 이유로 재큐잉하면 첫 워커가 아직 실행 중인데 두 번째 워커가 같은 잡을 처리하고, 첫 워커가 뒤늦게 결과를 덮어씁니다.

```sql
-- 획득: 선택과 running 전환을 한 트랜잭션에서 원자적으로
update jobs j set
  status = 'running', locked_by = $1, locked_at = now(),
  lease_expires_at = now() + interval '2 minutes',
  heartbeat_at = now(), fence_token = j.fence_token + 1, attempts = j.attempts + 1
where j.id = (
  select id from jobs
   where status = 'queued' and run_after <= now()
   order by id
   for update skip locked
   limit 1
)
returning j.id, j.fence_token, j.payload, j.stage;
```
- `attempts` 는 **획득 시점에 증가**합니다 = "실행 시도 횟수". 크래시로 결과를 남기지 못한 시도도 카운트되어야 무한 재시도를 막을 수 있습니다.
- 워커는 30초마다 heartbeat 갱신 — **자신의 fence token 조건 포함**:
  ```sql
  update jobs set heartbeat_at = now(), lease_expires_at = now() + $lease
   where id = $1 and fence_token = $2 and locked_by = $3 and status = 'running';
  -- 0행이면 lease 를 빼앗긴 것 → 워커는 즉시 작업을 중단한다
  ```
- **모든 결과 커밋에 `and fence_token = $token and locked_by = $worker` 조건**을 건다 → 좀비 워커의 늦은 쓰기가 무시됨

**reaper — 단일 상태 전이 SQL (R2-24)**

v2는 만료 잡을 무조건 `queued` 로 되돌렸는데, `attempts >= max_attempts` 인 잡까지 재큐잉되어 무한 루프가 됩니다.

```sql
update jobs set
  status      = case when attempts >= max_attempts then 'dead' else 'queued' end,
  run_after   = case when attempts >= max_attempts then run_after
                     else now() + least(power(2, attempts) * interval '2 s', interval '5 min')
                          + (random() * interval '5 s') end,
  locked_by = null, locked_at = null, lease_expires_at = null, heartbeat_at = null,
  last_error = coalesce(last_error, 'lease_expired')
where status = 'running' and lease_expires_at < now();
```
`fence_token` 은 여기서 증가시키지 않습니다 — 다음 획득 시 증가하므로 이전 소유자의 쓰기는 자동으로 무효화됩니다.

**lease 길이 (R2-25)**

2분은 안전성 보장이 아니라 **가용성 파라미터**입니다. fencing은 DB의 늦은 쓰기만 막을 뿐, 이벤트 루프가 멈춘 사이 발생한 **외부 API 중복 호출과 비용은 막지 못합니다.**

- lease는 스테이지별 **p99 실행시간 × 3** 으로 설정 (`homepage_detect` 90s, `search_analyze` 240s 등, 설정값)
- 외부 호출에는 **idempotency key** 를 전달해 재실행 시 과금이 중복되지 않게 함
- `cost_ledger.entry_key` 가 중복 과금을 DB 차원에서 한 번 더 막음

### 7.2 HTTP API

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| GET | `/api/runs` · `/api/runs/:id` | user | 실행 이력·상세(스테이지·비용·실패 잡) |
| POST | `/api/runs` | admin | 수동 실행 (`dryRun`, `industries[]`, `limit`) |
| POST | `/api/runs/:id/retry` | admin | `scope=failed \| stage`, `from=<stage>` |
| POST | `/api/runs/:id/cancel` | admin | 취소 |
| GET | `/api/review` · `/api/review/:companyId` | user | 검수 후보 목록·상세(점수 근거·ORS·경쟁사·연락처 페이지) |
| **POST** | **`/api/review/:id/contact-email`** | **user** | **연락처 수동 입력 → 문법·DNS·MX 검증 → `emails` 생성** |
| POST | `/api/review/:id/decision` | user | `decide_review_item` RPC (승인 시 `emailId` 필수) |
| POST | `/api/review/bulk-decision` | user | 일괄 **제외만** 허용 (승인은 이메일 필요하므로 개별) |
| POST | `/api/review/:id/competitors` | admin | 경쟁사 수동 교체 |
| GET | `/api/leads` · `/api/leads/export` | user / admin | 목록 · export(워터마크·감사·횟수 제한) |
| GET/PUT | `/api/settings` | admin | 설정 |
| GET/POST/PUT | `/api/industries`, `/api/keywords/:id/approve` | admin | 업종·키워드 |
| GET | `/api/costs` | user | 비용 집계 |
| **POST** | **`/api/privacy/request`** | **user** | **열람·삭제·처리정지 요청 접수 (F-08)** |
| POST | `/internal/run` | HMAC 서명 | pg_cron → 워커 트리거 |

**공통:** 성공 `{data, meta?}` / 실패 `{error:{code,message,details?}}` · 쓰기는 `Idempotency-Key` 지원 · 커서 페이징(기본 50, 최대 200) · 모든 쓰기 `audit_log` 기록 · CSP·CSRF 적용

---

## 8. 화면 구조 · 사용자 흐름

### 8.1 레이아웃

데스크톱 전용(1440px 최적화). 좌측 고정 사이드바 + 넓은 테이블 + 우측 상세 패널(480px). 카드·그래디언트·애니메이션·장식 차트 없음. 밀도 높은 테이블, 흑백 + 강조색 1, 상태는 텍스트 배지.

```
┌────────────┬──────────────────────────────────┬──────────────────┐
│ 오늘의 검수 │ 실행 상태 바 (진행·비용·카운트)     │ 상세 패널         │
│ 승인 리드   │ ────────────────────────────── │ 업체 요약         │
│ 업종·키워드 │ [필터] [일괄 제외]                │ 3축 점수 + 근거    │
│ 실행 이력   │ ┌─ TanStack Table ───────────┐  │ 취약점 목록        │
│ 설정       │ │ ☐ 업체 업종 지역 문제 구매   │  │ ORS 표 (채널별)    │
│            │ │   신뢰 총점 홈페이지 상태     │  │ 경쟁사 3곳 비교    │
│            │ │   ...가상 스크롤             │  │ 공식 채널 활성도   │
│            │ └────────────────────────────┘  │ ▸ 연락처 페이지 ↗  │
│            │                                  │ ▸ 이메일 입력 폼   │
│ 사용자     │                                  │ [승인] [제외]      │
└────────────┴──────────────────────────────────┴──────────────────┘
```

### 8.2 화면

**1) 오늘의 검수 `/today`** (기본 진입)
- 상단: 실행 상태, 단계별 진행, 원본→통과→분석→후보 카운트, 오늘 비용, 실패 건수, **네이버 쿼터 사용률**
- 컬럼: 선택 / 순위 / 업체명 / 업종 / 지역 / **문제** / **구매** / **신뢰** / 총점 / 취약점 배지 / 홈페이지 / 경쟁격차 / 최근콘텐츠 / 상태
- 키보드: `j`/`k` 이동, `x` 제외, `Space` 선택, `e` 이메일 입력 폼 포커스
- **일괄 처리는 제외만.** 승인은 이메일 확인이 필요하므로 개별 처리

**2) 연락처 입력 (상세 패널 내)** — v2 신규
```
연락처 페이지 후보                        [모두 새 탭으로 열기]
 ▸ /contact      "문의하기"        신뢰 0.91  ↗
 ▸ /about        "회사소개"        신뢰 0.64  ↗
 ▸ /privacy      "개인정보처리방침"  신뢰 0.52  ↗

이 페이지에서 확인한 업무용 이메일을 직접 입력하세요.
 이메일  [                    ]   유형 [대표 ▾]
 확인한 페이지 [/contact ▾]
                                          [검증 후 저장]
 ⓘ 시스템은 홈페이지에서 이메일을 자동 수집하지 않습니다.
   (정보통신망법 제50조의2)
 ⓘ 개인 이메일·대표자 개인 주소는 입력하지 마세요.
```
저장 시 문법 → DNS → MX 순으로 검증하고 결과를 즉시 표시합니다. MX 실패 시 승인 버튼이 비활성 상태로 유지됩니다.

**3) 승인 리드 `/leads`** — 승인일·업종·점수 필터, 근거 스냅샷, export(워터마크·감사·횟수 제한)

**4) 업종·키워드 `/industries`** — 템플릿(`{업체명}`·`{지역}`·`{진료과목}`), LLM 초안은 `approved=false`로 들어와 승인 후 사용

**5) 실행 이력 `/runs`** — 스테이지별 total/done/failed, 실패 잡(에러·시도·fence), 실패만/스테이지부터 재실행

**6) 설정 `/settings`** (admin) — 자동 실행, 수집량, **신규:재평가 비율**, **cooldown 일수**, 3축 가중치·임계값, 업종 비율, 캐시 TTL, **네이버 쿼터 상한**, **LLM 월 비용 상한**, 제외 도메인

### 8.3 사용자 흐름

```
검수자
로그인 → /today → 실행 상태 확인 → 상위 점수부터 상세 확인
  → 근거 납득 → 연락처 페이지 열람 → 이메일 수동 입력 → MX 통과 → 승인
  → 부적합이면 사유 선택 후 제외 (cooldown 자동 설정)
  → 상한 도달 또는 후보 소진 → /leads 에서 export

관리자
/runs partial 확인 → 실패 스테이지 재실행
/settings 목표·가중치 조정 → 다음 실행부터 적용 (settings_snapshot 동결)
/industries 신규 업종·키워드 승인
```

### 8.4 검수자 인적 비용 (S-01 — v2 신규)

| 작업 | 건당 | 일 최대 |
|---|---|---|
| 상세 패널 검토·판단 | 30~45초 × 100 | 50~75분 |
| **연락처 페이지 열람·이메일 입력** | **60~90초 × 최대 50** | **50~75분** |
| **합계** | | **약 100~150분/일** |

검수자 1인 기준 하루 2~2.5시간입니다. **연락처 조회는 승인 의사가 있는 후보에 대해서만 요구**하도록 UI를 구성해 낭비를 줄입니다. 이 비용이 수용 불가하면 `targets.final_max`를 낮추는 것이 유일한 조정 수단입니다.

---

## 9. 표본 검증 계획

F-20 반영: **Phase 0은 탐색적 검증(빨리 접을지 판단), Phase 4는 확증 검증(지표 타당성 확정)** 으로 분리합니다.

### 9.1 Phase 0 — 탐색적 검증 (n=120, 10일)

| 업종 | 표본 | 추출 |
|---|---|---|
| 피부과 / 성형외과 / 치과 | 각 30 | 지역 층화 무작위 (서울 15 / 광역시 8 / 그 외 7) |
| 프랜차이즈 가맹본부 | 30 | 가맹점 5~99개 층화 무작위 |

**가설검정을 하지 않습니다.** 점추정 + 95% 신뢰구간만 보고합니다.

**⚠️ v3 — Phase 0 판정은 `stop` 또는 `inconclusive` 두 값만 산출합니다 (R2-06)**

v2는 M7의 "95% CI 상한 ≥ 0.4"를 통과 기준으로 삼았는데, n=120에서는 **표본 상관이 `ρ̂ ≈ 0.24`만 넘어도 이 조건을 통과**합니다. 설명력 약 6%인 지표가 통과하는 게이트는 게이트가 아닙니다.

```
Phase 0 결과 = stop          → 명백한 실패. 프로젝트 중단 또는 스코프 재협상
             = inconclusive  → Phase 1 진행 허용. 단 SLA·배점은 확정하지 않음
❌ "go" 판정 없음
❌ Phase 0 결과로 targets.final_max 를 확정하지 않음 (Phase 4 이후)
❌ Phase 0 결과로 ORS 배점을 활성화하지 않음
```
업종 간 이질성(업종별 지표 편차)도 별도로 보고합니다.

| # | 지표 | 통과 기준 | 미달 시 |
|---|---|---|---|
| **M0** | **`U` 모집단 크기 · 소진 예상 영업일** | — (실측 보고) | 재평가 비율 재설계 |
| M1 | 홈페이지 발견률 | ≥ 70% | 소스 보강 |
| M2 | 공식 판별 정밀도 / 재현율 | ≥ 0.90 / ≥ 0.75 | 신호 가중치 조정 |
| **M3** | **연락처 페이지 후보 적중률** (사람이 그 페이지에서 실제 이메일을 찾은 비율) | **≥ 50%** | 페이지 탐지 규칙 보강 |
| **M3b** | **이메일 공개율** (사람이 홈페이지 전체를 봤을 때 업무용 이메일 존재 비율) | **≥ 30%** | **`final_max` 하향 또는 스코프 재협상** |
| M4 | MX 통과율 | ≥ 90% | — (해석 주의: F-27) |
| M5 | 중복 오병합률 | ≤ 2% | dedupe 키 보강 |
| M6 | ORS 산출 가능률 | ≥ 90% | 키워드 템플릿 수정 |
| **M7** | **ORS ↔ 체감 노출 Spearman ρ (탐색)** | **95% CI 상한 < 0.4 이면 `stop`** | ORS 배점 영구 0 / 축소 파이프라인 확정 |
| M8 | 경쟁사 선정 타당성 (1~5) | 평균 ≥ 3.5, 3점 미만 ≤ 20% | 선정 규칙 수정 |
| M9 | 최종 적합률 ("영업할 만하다") | ≥ 60% | 게이트·가중치 조정 |
| M10 | 업체당 시간 (스테이지 5~13) | ≤ 25초 | 동시성·캐시 조정 |
| M11 | 업체당 API 비용 | ≤ 15원 | 호출 예산 재배분 |
| **M12** | **업종별 false merge / false split** (F-31) | **점추정만 보고 (기준 없음)** — n=30에서 오류 0건이어도 rule of three 상한이 10%라 3% 검증 불가 (R2-33) | 확증은 Phase 4 확대 표본으로 이월 |
| **M13** | **렌더링 방식 분포** (SSR / JS 전용 / Cloudflare 차단) | — (실측) | JS 렌더링 필요 시 범위 재산정 |
| **M14** | **무료메일을 대표주소로 쓰는 비율** | — (실측) | `is_free_mail` 감점 정책 조정 |

**중단 게이트: M3b < 20% 또는 M7 신뢰구간 상한 < 0.4 → 진행 중단, 스코프 재협상**

### 9.2 Phase 4 — 확증 검증 (n=240)

ORS가 제품의 25점을 지탱하므로, Phase 4 완료 기준에 정식 검증을 둡니다.

- 표본: 업종별 60건 × 4 = **240건**, Phase 0 표본과 **분리**(시간 분리 holdout)
- 평가자 **2인**, 검색 환경 고정: **비로그인 · 시크릿 창 · 데스크톱 · 지역 고정 · 동일 시간대**
- **회사당 대표 키워드 1개만** 상관분석에 사용(독립성 확보), 다중 키워드는 부차 분석
- 사전등록 가설: `H0: ρ ≤ 0.4` vs `H1: ρ = 0.6`, 양측 α=.05, power=.80
  - 필요 n ≈ 111 (Fisher z: `((1.96+0.8416)/(0.6931−0.4236))² + 3`)
  - **⚠️ v3 정정 (R2-05): pooled 검정(n=240)만 1차 분석으로 사전등록합니다.** v2는 "업종별로도 충족"이라고 썼지만 **업종별 60 < 111** 이고, 평가자를 2명으로 늘려도 표본 수는 늘지 않습니다. 업종별 결과는 **탐색적 보고만** 합니다.
- 평가자 일치도 Krippendorff α ≥ 0.67 미달 시 척도 재설계 후 재측정
- **추가 완료 기준 (R2-10): 3축 간 상관·VIF·증분 설명력 측정.** VIF > 5 인 하위 항목은 통합합니다.
- **미달 시:** ORS 배점 **0을 유지**하고(기본값이 0이므로 별도 조치 불필요) "최근 콘텐츠 활동 부족" 축 중심 축소 파이프라인으로 확정 + 유료 SERP 도입 검토

### 9.3 산출물

`apps/spike` CLI · `fixtures/goldset.csv` · `fixtures/http/*.json`(녹화 응답) · `docs/02-sample-validation-report.md`

---

## 10. 단계별 개발 계획 · 완료 기준

각 Phase는 **완료 기준을 검증 명령으로 증명**해야 넘어갑니다. F-28 반영으로 **1인 기준 12~16주**로 재계획했습니다(v1 7~8주는 과소평가).

### Phase -1 — 법무·약관·데이터원 확정 (달력 2~4주 · 대기 중 병렬 작업) ← **여기서 시작**

F-29 반영: 법적으로 못 쓰는 파이프라인으로 골드셋을 만들면 그 골드셋이 무효가 됩니다.

- [ ] **변호사 검토 — 의견서 확보.** 질의 항목:
  1. 50조의2: **검수자 수동 전사 방식이 "자동 수집 프로그램·기술적 장치"에 해당하지 않는가**
  2. 50조: **사업자 공개 업무용 이메일로의 B2B 콜드 아웃바운드가 어떤 조건에서 허용되는가** ← 승인 전 질문 1
  3. 개인정보보호법: 처리근거·보유기간·제20조 출처 고지·권리 행사 절차
  4. 의료법 56조: 경쟁사 비교 자료의 내부 사용 범위
  5. 제28조의8: 국외이전 (Supabase·Hetzner·Anthropic 리전·수탁자)
- [ ] **네이버 API 약관 전문 확보** → 영업 리드 발굴 용도 허용 여부 확인. 애매하면 **서면 문의**. **회신 전까지 `FEATURE_ORS=off` 유지** ← 승인 전 질문 2
- [ ] **네이버 Search API의 API HUB 이관 여부·약관·쿼터·가격 확인** (R2-04)
- [ ] Google CSE 제거 확정, 대체 필요성 판단
- [ ] `source_registry` 초기 데이터 작성 및 승인 (`written_approval_ref` 포함)
- [ ] **국외이전 흐름도 산출** — 리전 / 수탁자 / 이전 항목 / 보유기간 (R2-27)
- [ ] 공공데이터포털 · 네이버 · YouTube API 키 발급 (심사 기간 포함)
- [ ] **에이전시로부터 단위경제 입력 수령** (결론 E 표) ← 승인 전 질문 3

**대기 중 병렬 진행 (법적으로 안전한 것만)**: 모노레포 골격 / `HttpClient` + **SSRF 방어** / 공공데이터 어댑터 / **`U` 실측** / 홈페이지 판별(이메일 추출 없이)

**완료 기준:** 법률 의견서 수령 · 네이버 회신 또는 약관 확인 완료 · `source_registry` 전 항목 `approved=true` · 국외이전 흐름도 승인

**게이트 2개**
- **50조의2 관련 의견이 "수동 입력도 위험"** → 제품 정의 재협상
- **50조 관련 의견이 "콜드 아웃바운드 불가"** → export 가능 리드가 0에 수렴하므로 **outbound 목적 자체를 재협상**. 리드를 "발굴 후 전화·방문 등 다른 채널로 접촉"용으로 재정의하는 안을 함께 검토

### Phase 0 — 표본 검증 스파이크 (10일)
- 산출: `apps/spike` CLI, 골드셋 120건, 검증 리포트
- 완료: M0~M14 실측 · `pnpm test` 통과 · **`final_max` 실 SLA 합의**
- **게이트: M3b < 20% 또는 M7 CI 상한 < 0.4 → 중단**

### Phase 1 — 기반 (5일)
pnpm+turbo, TS strict, Drizzle 스키마·마이그레이션·RLS, Supabase Auth, 앱 셸, shadcn/ui
- 완료: `pnpm build` · 마이그레이션 up/down · **RLS 테스트**(익명 차단 / user 쓰기 차단 / PostgREST 직접 UPDATE 차단 / admin 허용) · **함수 린트**(모든 `security definer` 함수가 `set search_path` + `revoke from public`) · **`redactPII()` 위반 시 실패하는 테스트**

### Phase 2 — 수집·정규화·제외 + HTTP 계층 (7일)
`SourceAdapter`(HIRA/FTC/LocalData/NTS + Mock), `HttpClient`(rate limit·retry·backoff·robots·cache), normalize/dedupe/group/exclude, **재검색 트랙**
- 완료: 실키 300~500건 수집 · 오병합 ≤2% · **SSRF 방어 테스트**(사설망·rebinding·redirect 체인·압축 폭탄) · HttpClient 단위 테스트 · `FEATURE_SOURCE=mock` 오프라인 통과

### Phase 3 — 홈페이지 판별·연락처 페이지 (6일)
다신호 판정 → `official_status`, 애그리게이터 블랙리스트, `contact_pages` 탐지
- 완료: 골드셋 M2 정밀도 ≥0.90 · **이메일 추출 코드가 존재하지 않음을 증명하는 테스트**(`packages/` 전체에 이메일 정규식 부재 검사) · M3 ≥50%

### Phase 4 — 검색·채널 + ORS 확증 검증 (8일)
`SearchAdapter`(네이버 4종 + local + Mock), 채널 분류·관련성·최근성, ORS 산출, RSS·YouTube 활성도, 쿼터 가드
- 완료: fixture 기반 분류 정확도 테스트 · 쿼터 초과 중단 테스트 · M6 ≥90% · **9.2 확증 검증(n=240) 통과 또는 배점 재설계**

### Phase 5 — 경쟁사·점수·추천 (6일)
경쟁사 선정·비교, **3축 점수**, 취약점 등급, 게이트, 근거 JSON, 추천 매핑
- 완료: 골드셋 회귀 테스트 · **`FEATURE_LLM=off` 전체 통과** · 점수 재현성(동일 관측 → 동일 점수) · **경쟁사 유효 <2 시 `unavailable` 처리 테스트**

### Phase 6 — 대시보드·검수·연락처 입력 (10일)
6개 화면, TanStack Table 가상 스크롤, 우측 패널, 키보드 검수, **연락처 수동 입력 + MX 검증**, RHF+Zod, RPC 연동
- 완료: **E2E(Playwright)** 로그인→검수→연락처 입력→MX→승인→리드→export · **동시 승인 51번째 거부 테스트** · 업종 비율 위반 거부 · **XSS 페이로드 렌더링 테스트** · 키보드 전체 조작

### Phase 7 — 스케줄러·운영·개인정보 (6일)
pg_cron+HMAC, reaper, 실패 재실행, `cost_ledger`, 용량·비용 알람, 정리 잡, **열람·삭제·처리정지 워크플로**, 백업·복구
- 완료: **평일 06:00 3영업일 연속 성공** · 강제 크래시 후 재개(fence token 검증) · 비용·쿼터 상한 중단 테스트 · **DB 복구 리허설 1회** · 용량 리포트

### Phase 8 — 안정화·인수 (5일)
- 완료: **연속 5영업일 무개입 운영** · 일 평균 리드 수 리포트 · `pnpm build && pnpm test && pnpm e2e` 전부 통과

**개발일 합계 약 63일 ≈ 12.6주. 법률·약관 대기 포함 12~16주.**

---

## 11. 추천 시작 방식

### 추천: **Phase -1(법무·약관 확정)을 착수하고, 그 대기 시간 동안 법적으로 안전한 Phase 0 사전 작업을 병렬 진행한다.**

v1에서는 Phase 0(표본 검증)을 추천했습니다. **v2에서 바꿉니다.**

**이유**

1. **v1의 전제 하나가 실제로 틀렸다.** 정보통신망법 50조의2를 잘못 인용한 채 120건을 돌렸다면, 그 골드셋의 핵심 지표(이메일 발견률)는 법적으로 사용할 수 없는 방식으로 측정된 값이라 그대로 버려야 합니다. 같은 종류의 오류가 네이버 약관에도 있을 수 있고(R2), 이건 **한 시간짜리 확인으로 3주를 지킬 수 있는 종류의 리스크**입니다.

2. **Phase -1은 대기 시간이 길지만 작업량은 적다.** 변호사 검토·네이버 회신·API 키 심사는 대부분 **기다리는 시간**입니다. 그 사이 모노레포 골격, HttpClient + SSRF 방어, 공공데이터 어댑터, `U` 실측, 홈페이지 판별은 **법적 확인과 무관하게 안전하게** 진행할 수 있습니다. 실질 손실은 거의 없습니다.

3. **`U` 실측은 지금 당장 할 수 있고 가장 큰 사업 판단을 좌우한다.** HIRA·공정위 API 전수 조회만으로 "이 제품이 몇 개월 치 리드를 만들 수 있는가"가 나옵니다. `U`가 1만 개 수준이면 일 400건 모델 자체를 다시 짜야 하고, 이건 법률 검토를 기다릴 필요가 없습니다.

4. **표본 검증의 가치는 그대로다.** Phase -1이 끝나면 확정된 데이터원으로 Phase 0을 돌립니다. 골드셋과 녹화 fixture는 Phase 2~5의 회귀 테스트 입력이 되어 버려지지 않습니다.

**첫 2주 실행 순서**

| 일 | 트랙 A (대기·확인) | 트랙 B (병렬 개발) |
|---|---|---|
| 1 | 변호사 선임·질의서 발송 / 네이버 약관 확보·문의 | 모노레포 골격, TS strict, turbo |
| 2 | 공공데이터·네이버·YouTube 키 신청 | `HttpClient` + rate limit + robots |
| 3 | — | **SSRF 방어 + 단위 테스트** |
| 4~5 | `source_registry` 초안 | HIRA·공정위 어댑터 |
| 6~7 | — | **`U` 전수 실측 → 소진 예상일 리포트** |
| 8~9 | 회신 대기 | 홈페이지 판별(이메일 추출 없이) + `contact_pages` |
| 10 | 법률 의견서 검토 | 표본 120건 추출·고정 |
| 11~14 | 결과 반영·데이터원 확정 | Phase 0 착수 |

### 실데이터 미준비 부분의 처리 원칙

| 구분 | 처리 |
|---|---|
| **실 어댑터** | 실제 키로 동작. 키 없으면 명확한 에러로 실패 (**조용한 폴백 금지**) |
| **Mock 어댑터** | `FEATURE_*=mock` 시에만 활성. **프로덕션 빌드에서 사용 시 부팅 실패** |
| **Fixture** | 녹화된 실제 응답. 테스트 전용, 런타임 사용 금지 |
| **환경변수** | `.env.example`에 전부 명시 + Zod 부팅 검증. 누락 시 즉시 종료 |
| **교체 방법** | 어댑터별 `README`에 계약 타입·키 발급 절차·교체 체크리스트 |
| **소스 승인** | `source_registry.approved = false` 인 어댑터는 **실행 거부** |

**가짜 응답만으로 완료 처리하지 않습니다.** 각 Phase 완료 기준에는 실데이터 실행 결과가 포함됩니다.

---

## 부록 A. 점수 설계 v2 (3축)

### A.1 v1의 문제 (F-21)

v1은 검색공백 35 + 콘텐츠부족 15 + 경쟁격차 20 = **70점이 "온라인 활동량이 적다"는 하나의 잠재변수를 세 번 측정**했습니다. 여기에 같은 신호로 취약점 게이트까지 적용하므로 총점 60이 독립적인 품질 경계라는 근거가 없고, 점수가 임계값 근처에 인위적으로 군집합니다.

### A.2 v2 — 3축 분리

**축 1 · 문제 크기 (Problem Size) 0~60** — "이 업체는 얼마나 검색 결과물이 부족한가"

| 항목 | 배점 (검증·허용 후) | **배점 (기본값 = 현재)** | 세부 |
|---|---|---|---|
| ORS 공백 | 25 | **0** | 공식 자산 회수 부재 10 / 제3자 콘텐츠 부재 8 / 채널 유형 다양성 부족 4 / 비브랜드 회수 부재 3 |
| 경쟁사 대비 격차 | 20 | **20** (ORS 격차 항목 제외 시 12) | ORS 격차 8 / 최근성 격차 5 / 다양성 격차 4 / 채널 활성도 격차 3 |
| 최근 콘텐츠 활동 부족 | 15 | **15** | 최근 60일 0건 8 / 61~120일 0건 4 / 최종 발행일 경과 3 |

> **⚠️ ORS는 기본 배점 0입니다 (결론 C · R2-02).** 네이버 서면 허용 + Phase 4 확증 검증을 모두 통과하기 전에는 산출·기록만 하는 shadow feature입니다. 이 상태에서 `axis_problem` 만점은 60이 아니라 **27**(= 12 + 15)이므로, **축 임계값과 총점 컷을 축소 모드용으로 별도 정의**합니다(A.5).

**축 2 · 구매 가능성 (Propensity) 0~25** — "이 업체가 우리 서비스를 살 수 있는가"

| 항목 | 배점 | 세부 |
|---|---|---|
| 사업성·제안 적합도 | 10 | 업종 단가 4 / 지역 경쟁강도 3 / 규모 적합 3 |
| **예산 신호** | 10 | **상호작용 규칙 적용 (A.3)** |
| 접점 품질 | 5 | 연락처 페이지 존재 3 / 페이지 유형(제휴·마케팅) 2 |

**축 3 · 데이터 신뢰도 (Confidence) 0~15**

| 항목 | 배점 |
|---|---|
| 공식 판정 등급 (`confirmed` 5 / `likely` 3) | 5 |
| 분석 완료 항목 비율 | 5 |
| 유효 경쟁사 수 + 소스 신선도 | 5 |

> 이메일 신뢰도는 **점수에서 제외**했습니다. 이메일은 승인 시점에 확보되므로 점수 계산 시점에 존재하지 않습니다. MX 통과는 승인 조건(하드 게이트)이며, "도메인 메일 수신 인프라 존재"로만 표기합니다(F-27).

### A.3 예산 신호 상호작용 규칙 (F-22)

v1은 "적극적 마케팅 운영 수준"을 무조건 가점했습니다. 이는 **이미 마케팅이 잘 되는 업체를 좋은 취약 리드로 만드는 역방향 신호**입니다. 이벤트·다채널·광고 랜딩이 많다는 건 예산 신호일 수도 있지만, 기존 대행사와 계약 중이라 교체 의향이 낮다는 신호일 수도 있습니다.

**⚠️ v3 — v2의 규칙은 dead code였다 (R2-11)**

게이트 통과 후보는 정의상 `axis_problem >= 32` 이므로 `high AND axis_problem < 32 → 0` 분기는 **게이트에 도달하지 않습니다.** 실제 후보 집합에서는 항상 `high → 10`, `low → 4`, 즉 v1과 동일한 단순 가점이었습니다.

**v3 — 조건을 `clear_gap`(경쟁사 대비 명확한 격차)으로 바꿉니다.** `clear_gap` 은 게이트의 필수 조건이 아니므로 실제로 변별력이 있고, 의미도 더 정확합니다 — 우리가 찾는 것은 "돈은 쓰는데 경쟁사보다 뒤처진" 업체입니다.

```
marketing_activity = high | low   (이벤트·프로모션 페이지, 다채널 운영, 광고 랜딩 흔적)

budget_signal_points =
  high AND clear_gap 존재      → 10   ✅ 예산은 있는데 경쟁사보다 뒤처짐 → 최우선 리드
  high AND clear_gap 없음      →  2   ❌ 이미 경쟁사 수준 → 교체 설득 어려움
  low  AND strong 취약점 존재  →  6   △ 예산 불확실하나 문제가 큼
  low  그 외                   →  3
```

### A.4 취약점 등급

| 등급 | 조건 |
|---|---|
| **strong** | 대표키워드 3개 중 2개 이상에서 관련 문서 회수 0건 / 최근 120일 공식 콘텐츠 0건 / 공식 채널 전무 |
| **medium** | 최근 60일 공식 콘텐츠 0건 / 채널 유형 2종 이하 / 제3자 콘텐츠 0건 |
| **clear_gap** | 유효 경쟁사 중앙값 대비 ORS 60% 이상 열위 |
| **weak** | 기술 SEO(title·meta·https·모바일) — **단독으로는 리드 불가** |

### A.5 게이트

**모드 A — ORS 활성 (네이버 서면 허용 + Phase 4 검증 통과 시)**
```
axis_problem    >= 32     (60점 만점의 53%)
AND axis_propensity >= 10 (25점 만점의 40%)
AND axis_confidence >=  9 (15점 만점의 60%)
AND total >= 60
```

**모드 B — ORS 비활성 (기본값 · 현재)**
```
axis_problem    >= 15     (27점 만점의 56%)
AND axis_propensity >= 10
AND axis_confidence >=  9
AND total >= 34           -- 67점 만점 기준. 요구사항의 "60점"은 100점 만점 기준이므로
                          -- 모드 B에서는 100점 환산값 (total/67*100) >= 60 으로 판정한다
```

**공통 (두 모드 모두)**
```
AND official_status IN ('confirmed', 'likely')
AND ( strong >= 1 OR medium >= 2 OR (clear_gap >= 1 AND medium >= 1) )
AND competitor_gap_available = true          -- 유효 경쟁사 >= 2
AND company.do_not_contact = false
```
**승인 시점 추가 게이트:** `email.mx_ok = true` AND `email.acquisition_method IN ('manual_entry','public_api')`

**축 하한과 총점을 함께 두는 이유 (R2-12에 대한 답)**

codex는 "축 최소값 합 `32+10+9=51` 은 축 게이트를 통과하고도 총점 60 때문에 탈락하므로 총점 조건이 불투명하다"고 지적했습니다. **이는 결함이 아니라 의도된 이중 조건입니다.**

| 조건 | 역할 | 없으면 생기는 실패 |
|---|---|---|
| 축 하한 | **필요조건** — 한 축 몰빵 방지 | 문제는 큰데 구매 가능성 0인 업체가 통과 |
| 총점 60 | **충분조건** — 전체 크기 확보 | 모든 축이 하한만 겨우 넘는 약한 후보가 대량 통과 |

총점 60점 이상은 **요구사항 원문의 명시적 조건**이기도 하므로 제거할 수 없습니다. 다만 "9점의 여유가 어느 축에서 와도 같다"는 가정에는 근거가 없으므로, **Phase 4에서 실제 승인·전환 결과로 임계값을 보정**하는 항목을 완료 기준에 넣습니다.

### A.6 경쟁사 결측 처리 (F-23)

```
유효 경쟁사(is_valid=true) 수 >= 2  → 중앙값으로 격차 산출
유효 경쟁사 수 <  2                 → axis_problem 의 경쟁격차 20점을 'unavailable'
                                       ❌ 총점 재정규화 금지 (결측이 허위 취약점이 되는 것 방지)
                                       → competitor_gap_available = false → 게이트 탈락
                                       → 수동 검수 큐로 별도 분리 (admin이 경쟁사 교체 가능)
```
`null`을 `0`으로 취급하지 않습니다. 성공한 경쟁사만 검색되는 선택편향을 막기 위해 경쟁사는 **검색 결과가 아니라 업종·행정동·규모 매칭**으로 선정합니다.

### A.7 추천 서비스

우선순위: `검색 점유·SEO 콘텐츠` → `매체 광고` → `콘텐츠 마케팅` → `홈페이지 개선`
주력 1개는 최고 감점 항목에서, 보조 최대 2개는 차순위에서. LLM은 **선정이 아니라 문장 정리에만** 사용.

---

## 부록 B. LLM 사용 범위

| 용도 | 입력 | 출력 | 실패 시 |
|---|---|---|---|
| 업종 키워드 초안 | 업종명·지역 | 키워드 후보 10개 | 템플릿 키워드 |
| 검색 의도 분류 | 키워드 | 정보형/거래형/브랜드형 | 규칙 분류 |
| 취약점·추천 문장 정리 | **점수 근거 JSON (PII 제거됨)** | 2~3문장 | 템플릿 문장 |

- 모델 Claude Haiku 4.5 · 프롬프트 캐싱 + 결과 캐싱 · 월 비용 하드 상한
- **금지:** 점수 산정 / 공식 여부 판정 / 경쟁사 선정 / 이메일 유효성 판단 / **이메일·담당자명 등 PII 전송(R7)**
- 기본값 `FEATURE_LLM=off`, 이 상태로 전체 파이프라인 통과가 P5 완료 기준

---

## 부록 C. v1 → v2 변경 이력

전체 판정은 `docs/01-critique-round1.md`, 원본 비평은 `docs/critique/round1-codex-raw.md`.

| # | 변경 | 근거 |
|---|---|---|
| 1 | **홈페이지 이메일 자동 추출 제거 → 검수자 수동 입력** | F-01 (조문 오인용, 검증 완료) |
| 2 | 이메일 게이트를 파이프라인 후단으로 이동 | F-01 파생 |
| 3 | Google CSE 제거 | F-03 (공식 종료 공지 확인) |
| 4 | SoSR → ORS, 35 → 25점, 해석·표기 제한 | F-04 (부분 수용) |
| 5 | 수율 재계산 11~30 → 7~21, 50은 상한으로 | F-05 |
| 6 | 재검색 트랙·cooldown·`company_observations` 신설 | F-06 |
| 7 | 동의·DNC·보유기간 필드, 개인정보 워크플로 | F-07 · F-08 |
| 8 | 국외이전 통제 + `redactPII()` | F-09 |
| 9 | 네이버 호출량 3,840 재산정, 경쟁사 키워드 1개로 한정 | F-10 |
| 10 | 원본 SERP 행 미저장 → `search_hits` + `search_aggregates` | F-11 |
| 11 | **`review_items` authenticated UPDATE 정책 삭제** | F-12 (실제 보안 구멍) |
| 12 | 승인 RPC 카운터 직렬화 + `revoke from public` | F-13 |
| 13 | 워커 전용 최소권한 DB 역할 (`service_role` 오용 수정) | F-14 |
| 14 | lease + heartbeat + fencing token | F-15 |
| 15 | 결과 테이블 멱등 유일키, `email_occurrences` 분리 | F-16 |
| 16 | DAG + completeness + `partial` 집계 SQL + invalidation | F-17 |
| 17 | cron 부분 유일 인덱스, 복합 FK, canonical URL, 경쟁사 유일성 | F-18 |
| 18 | 관측 테이블 분리 + `scores.observation_id` | F-19 |
| 19 | 검증을 탐색(120) / 확증(240·2인) 2단계로 | F-20 (부분 수용) |
| 20 | **점수 3축 분리 + 축별 임계값** | F-21 |
| 21 | 예산 신호 상호작용 규칙 | F-22 |
| 22 | 경쟁사 결측 시 `unavailable`, 재정규화 금지 | F-23 |
| 23 | **SSRF·rebinding·XSS 방어 (v1에 전무)** | F-24 |
| 24 | `source_registry`, `noindex` 분리 | F-25 |
| 25 | 의료광고 3단 분리 | F-26 |
| 26 | MX 해석 정정, 점수에서 제외 | F-27 |
| 27 | 일정 7~8주 → 12~16주 | F-28 |
| 28 | **Phase -1 신설, 시작 방식 변경** | F-29 |
| 29 | 백업·모니터링·토큰 상한 포함 최악조건 예산 | F-30 |
| 30 | 한국 실데이터 특성 측정 항목(M12~M14) | F-31 |
| 31 | `CREATE EXTENSION citext` 명시 | F-32 |
| 32 | 검수자 인적 비용 명시 / export 통제 / 경쟁사도 데이터 주체 | S-01 · S-02 · S-03 |
| — | **네이버 약관 위반 주장은 근거 미검증 → Phase -1 확인 액션으로 전환** | F-02 (보류) |

## 부록 D. v2 → v3 변경 이력

codex 라운드 2 비평 41건. 전체 판정은 `docs/02-critique-round2.md`, 원본은 `docs/critique/round2-codex-raw.md`.

| # | 변경 | 근거 |
|---|---|---|
| 1 | **승인 RPC 업종 비율 공식 교체** — `(cnt+1)/(total+1)` 은 첫 승인부터 항상 거부. 절대 쿼터 `floor(cap × share_max)` 로 | R2-01 (승인 기능 동작 불능) |
| 2 | **ORS를 fail-closed shadow feature로** — 기본 배점 0, 서면 허용 + Phase 4 검증 전까지 비활성. 축소 파이프라인을 1급 경로로 | R2-02 |
| 3 | **수집 근거 / 접촉 근거 분리** — `collection_legal_basis`(NOT NULL) vs `contact_legal_basis`(NOT NULL). export는 접촉 근거 있는 리드만 | R2-03 |
| 4 | `NaverSearchAdapter` 를 `legacy`/`apihub` 로 분리, API HUB 확인을 Phase -1에 | R2-04 (미검증) |
| 5 | Phase 4 검증을 **pooled 단일 1차 분석**으로 사전등록. 업종별은 탐색적 보고만 | R2-05 |
| 6 | **Phase 0 판정을 `stop`/`inconclusive` 두 값으로.** go 판정·SLA 확정 금지 | R2-06 |
| 7 | **연락처 페이지 본문을 fetch·캐시하지 않음.** 링크 URL·앵커 텍스트만으로 탐지 | R2-07 |
| 8 | `enter_contact_email` 전문 작성 — nonce·rate limit·페이지 결속·감사 로그 | R2-08 |
| 9 | ORS 분모 `min(30, total_returned)`, 채널 간 중복 제거 유일키 | R2-09 |
| 10 | 3축 상관·VIF·증분 설명력 측정을 Phase 4 완료 기준에 | R2-10 |
| 11 | **예산 신호 조건을 `axis_problem` → `clear_gap` 으로** (dead code 제거) | R2-11 |
| 12 | 축 하한 + 총점 이중 조건의 설계 의도 명시 + Phase 4 보정 | R2-12 (부분 반박) |
| 13 | DB 용량 30/180/365일 p50·p95 재산정. **180일에 self-host 이전 기정사실화** | R2-13 |
| 14 | `all_url_hashes`·`classifier_version` 보존, `search_hits(collected_at)` 인덱스 | R2-14 |
| 15 | **재평가를 주기가 아니라 변경 탐지로 촉발.** 일일 목표를 가용 후보 수의 함수로 | R2-15 |
| 16 | 상태 전이를 `pending → approved\|rejected` 로 고정 + `revoke_approval()` 보상 | R2-16 |
| 17 | `ON CONFLICT` 제거 + `GET DIAGNOSTICS ROW_COUNT` 검증 | R2-17 |
| 18 | 승인 카운터를 `(approval_date, industry)` 기준으로 (수동 run 우회 차단) | R2-18 |
| 19 | 설정을 `settings_snapshot` 에서 `INTO STRICT` + 범위 검증 (fail-open 제거) | R2-19 |
| 20 | RLS·정책·함수 권한 전수 검증 SQL을 P1 완료 기준에. `approval_counters` 완전 비공개 | R2-20 |
| 21 | `run_attempts` 1급 엔터티화, 모든 유일키에 `attempt_id` | R2-21 |
| 22 | `review_items` 단일 복합 FK `(score_id, run_id, company_id)` | R2-22 |
| 23 | `score_inputs` 연결 테이블 + `rule_version` | R2-23 |
| 24 | reaper 단일 상태 전이 SQL, `attempts >= max_attempts` → `dead` | R2-24 |
| 25 | lease를 스테이지별 p99×3, 외부 호출 idempotency key | R2-25 |
| 26 | `privacy_requests` 테이블, 개인정보 필드 NOT NULL, legal hold | R2-26 |
| 27 | 국외이전 흐름도 산출물을 Phase -1에 | R2-27 |
| 28 | **단위경제 입력 요청 명시** — 없이 "사업성 있다"고 말하지 않음 | R2-28 |
| 29 | **YouTube `search.list`(100 units) 제거 → `channels.list`(1 unit)** | R2-29 |
| 30 | `leadops_worker` 역할 DDL·grant·회전 runbook | R2-30 |
| 31 | SSRF에 IPv4-mapped IPv6·NAT64·숫자형 IP·userinfo·최종 peer IP 재확인 추가 | R2-31 |
| 32 | `leads.use_scope='internal_only'` 강제, MVP에서 대외 문구 완전 제외 | R2-32 |
| 33 | M12 통과 기준 제거(점추정만) — n=30으로 3% 검증 불가 | R2-33 |
| 34 | `create schema if not exists extensions` + `extensions.citext` 수식 | R2-34 |
| 35 | "월 운영비" → **"월 인프라비"**, 검수 인건비 병기 | R2-41 |

### 라운드 3 — v3 편집 자체의 결함 수정

codex에 BLOCKER 수정 여부만 좁게 재확인시킨 결과, **v3 편집이 새로 만든 결함 5건**이 나와 함께 수정했습니다.

| # | 결함 | 수정 |
|---|---|---|
| 36 | `run_attempts` 가 아직 없는 `runs(id)` 참조 → **마이그레이션 실패** | `runs` 다음으로 이동 |
| 37 | `review_view_nonces` 테이블 미정의인데 RPC가 참조 | 테이블 DDL 추가 |
| 38 | 업종 행만 잠가 **서로 다른 업종 동시 승인 시 일 상한 50 초과 가능** | `approval_day_totals` 신설, 잠금 순서 고정 |
| 39 | `scores.run_id` ↔ `attempt_id` 정합성 미보장 | `run_attempts unique(id, run_id)` + 복합 FK |
| 40 | ORS "부팅 거부" vs "shadow 산출" 모순 | **3-state** (`off`/`shadow`/`on`) 로 정리 |
| 41 | `enter_contact_email` 충돌 경로가 행위자·페이지 미갱신 | `do update` 에서 증거 필드 전부 갱신 |
| 42 | export 게이트가 선언만 존재 | `export_leads()` 함수로 SQL 강제 |
| 43 | `review_items` 에 `attempt_id` 없어 재실행 불가 | `attempt_id` + 유일키 + pending 중복 방지 인덱스 |
