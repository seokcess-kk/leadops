# LeadOps — Outbound Lead Finder

마케팅 에이전시 내부용 리드 발굴 도구. 검색 수요는 있으나 검색 결과물·콘텐츠 점유가
경쟁사보다 부족한 업체를 찾아 영업 가치가 높은 리드만 선별한다.

> **현재 상태: Phase 6 진행 (검수 API·MX·UI 연동 완료 / E2E·나머지 엔드포인트 미완)**
> 설계서 `docs/00-plan.md` v3 기준. 검수 → 이메일 → 승인 → 리드가 UI 에서 실제로 동작한다.

## 문서

| 파일 | 내용 |
|---|---|
| [`docs/00-plan.md`](docs/00-plan.md) | 설계서 v3 — 요구사항·위험·비용·아키텍처·ERD·API·화면·검증·개발계획 |
| [`docs/01-critique-round1.md`](docs/01-critique-round1.md) | codex 비평 라운드 1 판정 (32건) |
| [`docs/02-critique-round2.md`](docs/02-critique-round2.md) | codex 비평 라운드 2 판정 (41건) + 라운드 3 검증 |
| [`docs/03-decisions.md`](docs/03-decisions.md) | 발주자 의사결정 기록 (D-001 ~ D-004) |
| [`docs/04-code-review-round1.md`](docs/04-code-review-round1.md) | codex 코드 리뷰 판정 — 기반 계층 (13건) |
| [`docs/05-code-review-round2.md`](docs/05-code-review-round2.md) | codex 코드 리뷰 판정 — DB 계층 (11건) |
| [`docs/06-adapter-verification.md`](docs/06-adapter-verification.md) | **어댑터 실 API 검증 절차** — 키 발급부터 플래그 전환까지 |
| `docs/critique/` | codex 원본 비평 보존 |

## 빠른 시작

```bash
pnpm install
cp .env.example .env      # 목업 모드로 바로 동작한다

pnpm db:up                # 테스트용 Postgres 17 컨테이너 (Docker 필요)
pnpm verify               # typecheck + 633 단위 + 214 DB 테스트

pnpm spike universe       # 모집단 크기(M0)와 소진 곡선
```

DB 테스트는 **실제 Postgres** 를 쓴다. RLS·plpgsql·행 잠금·복합 FK 는 흉내 낼 수 없고,
흉내 낸 것으로 통과시키면 검증한 것이 아니기 때문이다. Docker 가 없으면
`pnpm test` 만 돌리면 되지만, 그 경우 DB 계층은 **검증되지 않은 상태**다.

실데이터로 돌리려면 `.env` 에 공공데이터포털 키를 넣고 `FEATURE_SOURCE=live` 로 바꾼다.

```bash
pnpm spike universe --industry dental,derm
pnpm spike sample --per-industry 30 --seed 42   # 골드셋 라벨링용 CSV
```

## 구조

```
packages/core       도메인 타입 · 환경변수 검증 · 에러 · PII 마스킹 · 소스 레지스트리 · 로거
packages/http       SSRF 방어 · robots.txt 파서·게이트 · rate limit · 백오프 · HttpClient
packages/adapters   SourceAdapter · SearchAdapter 계약 · HIRA · 공정위 · 네이버 검색 ·
                    RSS·Atom 피드 파서 · Mock · 팩토리
packages/db         마이그레이션 · RLS · RPC · 테스트 하네스
packages/pipeline   정규화 · 중복 제거 · 제외 규칙 · HTML 스캐너 · 도메인 분류 ·
                    공식 홈페이지 판정 · 연락처 페이지 탐지 · 채널 발견 · 활성도 산출 ·
                    키워드 생성 · ORS 산출 · 쿼터 가드 · 경쟁사 매칭 · 취약점 등급 ·
                    3축 점수 · 게이트 · 추천 매핑 · 스테이지 · 오케스트레이션
apps/api            검수 API (JWT 검증 · RLS 세션 · MX 게이트 · 에러 봉투)
apps/worker         잡 루프 (fencing · heartbeat · 안전 종료)
apps/spike          Phase 0 스파이크 CLI (DB 없이 동작)
taimen/             검수 콘솔 UI (Next.js 16 · 아직 fixture 모드)
```

### DB 계층 (packages/db)

| 마이그레이션 | 내용 |
|---|---|
| `0000_local_bootstrap` | 로컬 전용 — 역할·`auth` 스키마 스텁. **Supabase 에는 적용하지 않는다** |
| `0001_extensions_and_enums` | `extensions.citext`, 열거형 |
| `0002_tables` | 34개 테이블 · 복합 FK · CHECK 제약 |
| `0003_rls` | 전 테이블 RLS · 읽기 정책 · 워커 정책 |
| `0004_functions` | RPC 15종 |
| `0005_grants` | 최소 권한 GRANT · 함수 실행권 |
| `0006_seed` | 설정·소스 레지스트리 시드 |
| `0007_raw_candidates` | 수집 원본 (7일 보관) |
| `0008_channel_saturation` | 피드 포화 표시 · ORS 분모 0 허용 |
| `0009_collection_scope` | 수집 범위 설정 (`hira_scope`) |
| `0010_verify_contact_email` | MX 검증 결과 기록 RPC (서버 전용) |

**최초 admin 부트스트랩** (배포 runbook): DB 소유자가 직접 승격한다.
```sql
update public.profiles set role = 'admin' where email = '<운영자 이메일>';
```
권한 승격 경로를 애플리케이션에 두면 그 경로 자체가 공격면이 되므로 RPC 로 만들지 않았다.
이후의 역할 변경은 `set_profile_role` RPC(admin 전용)로 한다.

RPC: `decide_review_item` · `enter_contact_email` · `issue_review_nonce` ·
`revoke_approval` · `set_contact_basis` · `export_leads` · `update_setting` ·
`snapshot_settings` · `reap_expired_jobs` · `cleanup_old_data` ·
`acquire_job` · `heartbeat_job` · `complete_job` · `set_profile_role` · `update_source_registry`

## 이 코드가 강제하는 규칙

문서에만 있는 규칙은 언제든 되돌아간다. 아래는 **테스트가 깨지도록** 만들어 두었다.

| 규칙 | 강제 위치 |
|---|---|
| **홈페이지에서 이메일을 자동 추출하지 않는다** (정보통신망법 제50조의2) | `packages/core/src/policy.test.ts` — 소스 전체를 스캔해 이메일 추출 정규식이 생기면 실패 |
| 이메일·전화·주민번호는 로그·LLM 프롬프트로 나가지 않는다 | `packages/core/src/redact.ts` + 로거가 출력 직전 강제 호출 |
| SSRF·DNS rebinding 차단 (IPv4-mapped·NAT64·6to4 포함) | `packages/http/src/ssrf.ts` — 71개 테스트 |
| **IPv6 는 기본 거부** — 전역 유니캐스트 `2000::/3` 밖은 전부 차단 | `packages/http/src/ip.ts` |
| 압축 폭탄은 **해제 후** 크기로 잘리고, 상한에 닿으면 스트림을 끊는다 | `packages/http/src/client.ts` |
| API 키가 로그·에러 메시지에 남지 않는다 | `redactUrl()` — 모든 URL 로깅 경로에 적용 |
| robots 패턴 ReDoS 방어 (와일드카드·길이 상한) | `packages/http/src/robots.ts` |
| 포털 응답이 손상되면 "0건"이 아니라 에러다 (fail-open 금지) | `packages/adapters/src/dataGoKr.ts` |
| **인증 사용자는 어떤 테이블에도 직접 쓸 수 없다** (정책·GRANT 두 겹) | `rls.pg.test.ts` — 12가지 우회 시도가 전부 막힘 |
| 승인 상한·업종 쿼터는 동시 요청에서도 지켜진다 | `rpc.pg.test.ts` — 행 잠금 직렬화 검증 |
| 수동 run 을 추가해도 일 상한을 우회할 수 없다 | 카운터가 승인일 기준 |
| 설정이 없거나 범위를 벗어나면 통과가 아니라 에러다 | `configuration_error` |
| 이메일 입력은 화면을 연 세션만 가능하고 분당 횟수가 제한된다 | 1회용 nonce + rate limit |
| `manual_entry` 이메일은 증거(행위자·시각·본 페이지) 없이 존재할 수 없다 | CHECK 제약 |
| 접촉 근거·수신거부·개인정보 요청·보유기간이 export 를 막는다 | `export_leads()` |
| 무효화된 점수·게이트 미통과 점수로는 승인할 수 없다 | 승인 시 `for share` + 재검사 |
| **좀비 워커의 늦은 쓰기가 무시된다** (fencing token) | `jobs.pg.test.ts` — 워커는 `jobs` UPDATE 권한 없음 |
| 잠금 순서가 승인·취소에서 동일하다 (교착 방지) | 카운터 → leads |
| export 에서 제외된 건수가 감사 로그에 남는다 (조용한 누락 방지) | `skipped_capped` |
| redirect 는 홉마다 전부 재검증한다 | `packages/http/src/client.test.ts` |
| robots.txt 조회 실패는 fail-closed | `packages/http/src/robots.ts` · `robotsGate.ts` |
| **연락처 페이지의 `mailto:` 링크는 후보로 저장되지 않는다** (href 자체가 이메일이다) | `packages/pipeline/src/contactPages.ts` — 후보 URL 에 `@` 부재 검사 |
| **연락처 페이지의 본문은 fetch 하지 않는다** — 링크 URL·앵커 텍스트만 본다 | `contact_body_never_fetched` CHECK + `homepage.pg.test.ts` |
| HTML 스캐너는 **본문 텍스트를 반환하지 않는다** (예/아니오 대조만) | `packages/pipeline/src/html.ts` — 직렬화 결과에 본문 부재 검사 |
| 스크립트·스타일 안의 내용은 링크·전화 신호가 되지 않는다 | `html.test.ts` |
| 애그리게이터·SNS 는 공식 홈페이지가 될 수 없다 (redirect 최종 URL 기준) | `packages/pipeline/src/aggregators.ts` |
| 여러 도메인이 같은 본문을 주면 전부 강등된다 (DNS 하이재킹 방어) | `stages/contactPages.ts` |
| HTTP 계층 없이 홈페이지 판별을 "완료" 로 기록할 수 없다 | `requireFetching()` — `configuration_error` |
| `noindex` 는 차단 사유가 아니다 (색인 지시일 뿐) | 같은 파일 |
| 키가 없으면 mock 으로 조용히 폴백하지 않고 부팅에 실패한다 | `packages/core/src/env.ts` |
| **쿼터는 호출 전에 선점한다** — 재시도가 이중 계상되지 않고 동시 선점이 한도를 넘지 않는다 | `packages/pipeline/src/quota.ts` · `phase4.pg.test.ts` |
| ORS 분모가 0 이면 0 이 아니라 **null** (측정 불가와 측정값 0 을 구분) | `packages/pipeline/src/ors.ts` |
| 브랜드·비브랜드 ORS 를 합산하지 않는다 | `search_aggregates.keyword_kind` |
| 공유 호스트(`blog.naver.com`)의 남의 글을 공식으로 오인하지 않는다 | 경로까지 대조 — `ors.test.ts` |
| 네이버 응답이 손상되면 "0건"이 아니라 에러다 (fail-open 금지) | `packages/adapters/src/search.ts` |
| 피드 파서는 **본문을 반환하지 않는다** (발행 시각·제목만) | `packages/adapters/src/feed.ts` |
| 추측한 피드 주소로 요청을 보내지 않는다 (브런치·유튜브 핸들) | `packages/pipeline/src/channels.ts` |
| 검색 어댑터가 없으면 실패가 아니라 **건너뛴다** (축소 파이프라인이 1급 경로) | `stages/search.ts` |
| **측정하지 못한 항목은 0점이 아니라 `unavailable`** — 만점에서 빠지고 재정규화하지 않는다 | `packages/pipeline/src/scoring.ts` · `scoring.test.ts` |
| 유효 경쟁사 2곳 미만이면 게이트에서 탈락한다 (허위 취약점 방지) | 같은 파일 — `competitorGapAvailable` |
| **약한 기술 SEO 만으로는 리드가 되지 않는다** | `weakness.ts` — `weak` 등급은 게이트 계산에서 제외 |
| 마케팅이 활발한데 격차가 없으면 **감점**이다 (역방향 신호 방지) | `A.3` 상호작용 규칙 — `scoring.test.ts` |
| 경쟁사를 검색 결과로 뽑지 않는다 (선택편향 차단) | `stages/competitor.ts` — 업종·지역·규모 매칭 |
| 같은 네트워크·다지점은 경쟁사가 아니다 | 같은 파일 — `group_id` 제외 |
| 같은 관측이면 같은 점수가 나온다 (재현성) | `scoring.test.ts` · `score_inputs` 로 관측 버전 고정 |
| 추천 서비스는 **규칙이 고른다** (LLM 은 문장 정리만) | `recommend.ts` — `rationale_source = 'rule'` |
| 스테이지 순회가 무한 루프에 빠지지 않는다 (처리 못 한 행이 다시 잡히지 않음) | offset 순회 — `score`·`competitor_select`·`recommend` |
| **MX 검증 결과를 `authenticated` 가 쓸 수 없다** (승인 게이트 우회 차단) | 마이그레이션 0010 + `schema.pg.test.ts` + `api.pg.test.ts` |
| JWT `alg` 혼동·서명 위조·만료·비 UUID `sub` 가 모두 막힌다 | `apps/api/src/jwt.test.ts` — 19개 |
| 사용자 id 는 요청 컨텍스트로만 흐른다 (동시 요청이 섞이지 않는다) | `Ctx.userId` — 공유 변수 금지 |
| 인증은 라우팅보다 **먼저** 통과한다 (라우트마다 검사하면 빠뜨린다) | `apps/api/src/server.ts` |
| 알 수 없는 오류를 4xx 로 내리지 않는다 (규칙 위반과 버그를 섞지 않는다) | `toApiError` — 목록에 없으면 500 |
| SMTP 프로빙을 하지 않는다 · null MX 는 거부한다 | `packages/http/src/mx.ts` |
| 일괄 처리에 **승인 경로가 없다** | `stages`/API 양쪽 — `bulk-decision` 은 제외만 |
| **토큰이 브라우저에 내려가지 않는다** | `taimen/src/app/api/gateway` 프록시 + `src/lib/server/token.ts` |
| 프록시는 허용 목록 밖 경로를 404 로 막는다 | 같은 파일 — `ALLOWED` |
| 인증이 구성되지 않으면 **거부한다** (조용한 폴백 금지) | `sessionToken()` — `401 auth_unavailable` |
| UI 는 낙관적 갱신을 하지 않는다 (실패한 승인이 성공처럼 보이지 않게) | `taimen/src/lib/data/store.tsx` |
| UI 도 모르는 값을 0 으로 채우지 않는다 | `mapper.ts` · `CompetitorComparison` · `SearchGapPanel` |
| UI 의 취약점 등급이 백엔드 어휘와 같다 | `WeaknessSeverity` — 변환 계층을 두지 않는다 |
| `email_type` 허용 목록이 DB 열거형과 일치한다 | `routes/review.ts` — 어긋나면 400 이 아니라 500 이 된다 |
| `NODE_ENV=production` 에서 mock 어댑터는 부팅을 막는다 | 같은 파일 |
| ORS(네이버)는 자격증명 없이 켤 수 없다 | 같은 파일 |
| 승인되지 않은 데이터 소스는 어댑터가 실행을 거부한다 | `packages/core/src/sourceRegistry.ts` |

## ⚠️ 검증 상태

**실 API 응답으로 검증되지 않은 부분이 있다.** 가짜 응답으로 "완료" 처리하지 않기 위해
어댑터마다 `verifiedAgainstLiveApi` 플래그를 두었고, CLI 가 실행할 때마다 경고한다.

| 어댑터 | 상태 | 남은 일 |
|---|---|---|
| `MockSourceAdapter` | 해당 없음 | — |
| `HiraHospitalAdapter` | ✅ **검증됨** (2026-07-30) | 없음. 경로·필드·코드값 전부 실응답으로 확인, fixture 회귀 테스트 있음 |
| `FtcFranchiseAdapter` | ❌ **미검증 · 진단 불가** | 후보 전부 500 인데 **음성 대조군도 같은 500** — 경로 추측이 무의미하다. **공정위 가맹정보** 데이터셋 가이드 문서의 요청주소가 필요 (HIRA 가이드에는 없음) |
| `NaverSearchAdapter` | **미검증** | 자격증명 없음. 응답 fixture 는 개발자 문서 기반 추정. API HUB 이관 여부도 미확인(R2-04) |
| RSS·Atom 피드 | **검증됨** | 키 불필요. RSS 2.0 · Atom · RDF 파싱 테스트 통과 |

`pnpm spike verify` 가 엔드포인트 후보를 탐색하고, 코드값을 검사하고, 실제 응답을
`fixtures/http/` 에 fixture 로 녹화한다. 절차는
[docs/06-adapter-verification.md](docs/06-adapter-verification.md).

### 실측된 모집단 (2026-07-30)

수집 범위는 `settings.collection.hira_scope` 가 정한다. **발주자 결정: `name`.**

| 업종 | `name` (현재) | `specialty` | 차이 |
|---|---:|---:|---|
| 피부과 | **1,555** | 16,987 | 신고 기준은 **전체 의원의 45%** — 피부 시술 겸하는 일반의원 포함 |
| 성형외과 | **1,236** | 4,883 | |
| 치과 | 19,399 | — | 종별 코드라 이름이 곧 종류 |
| 합계 | **22,190** | 41,268 | |

`name` 으로 좁힌 이유: `specialty` 로 모으면 "피부과 마케팅" 제안이 맞지 않는 일반의원이
대량 섞인다. 실측 표본 16곳은 **100%** 기관명에 과목명이 들어 있다.
넓히려면 코드를 고치지 말고 설정을 `specialty` 로 바꾼다.

소진 곡선(22,190 기준): 210건/일이면 **106 영업일 ≈ 4.8개월**.

> ⚠️ **업종 구성이 한쪽으로 쏠려 있다.** 치과가 87.4%, 피부과+성형외과가 12.6%(2,791곳)다.
> 업종 비율 상한(60%)을 지키려면 리드의 40%를 이 2,791곳에서 뽑아야 하므로 이쪽이 **약 3개월
> 만에 먼저 소진**된다. 그 뒤에는 치과만 남아 일 승인 상한이 50 → 30(60%)으로 낮아진다.
> 결론 E 의 현실적 산출량(7~21건/일)에서는 구속력이 없지만, 목표를 올릴 때 먼저 부딪히는 벽이다.

## 파이프라인 (Phase 5 완료 구간 · 12개 스테이지)

```
collect          어댑터 → raw_candidates       (업종당 잡 1개)
  ↓
normalize        raw → companies + 관측 이력    (중복 제거 · 변경 탐지)
  ↓
exclude_basic    폐업·휴업·대형·가맹100+ 제외
  ├──────────────────────────────────┐
  ↓                                  ↓
homepage_detect                  competitor_select   업종·지역·규모 매칭 (검색 아님)
  ↓                                  │
  ├─ contact_pages    게이트·집계 (요청 0회)
  ├─ channel_analyze  공개 RSS·Atom → 발행량·주기·성격
  └─ search_analyze   네이버 4채널 → ORS (off 면 건너뜀)
       ↓                             ↓
       └──────→ competitor_analyze ←─┘   최근 관측에서 경쟁사 지표
                     ↓
                   score            3축 점수 + 취약점 등급 + 게이트
                     ↓
       ┌─────────────┴─────────────┐
   recommend                   shortlist    업종 쿼터 → 검수 후보 ≤100
```

각 스테이지는 **멱등**하다. 선행 스테이지가 terminal 이 되면 다음 스테이지가 자동으로
enqueue 된다(잡 큐에는 의존 관계 개념이 없으므로 오케스트레이터가 DAG 를 만든다).

**변경 탐지**(설계서 결론 D): 재평가는 주기가 아니라 **변경**이 촉발한다.
같은 업체를 다시 수집하면 `content_fingerprint` 를 비교해 `new` / `changed` / `unchanged`
로 기록하고, 변경이 없으면 cooldown 이 만료돼도 다시 돌지 않는다.

### 공식 홈페이지 판정

한 신호로 정하지 않는다. HIRA 의 `hospUrl` 이 그 업체 것이라는 보장이 없고(플레이스·블로그
주소가 들어오기도 한다), 도메인 이름만으로는 한글 상호를 맞출 수 없다. 그래서 **이미 알고
있는 사실과의 대조**를 합산한다.

| 신호 | 배점 | 비고 |
|---|---:|---|
| 전화번호 일치 | +35 | 공공 API 로 받은 대표번호가 그 페이지에 있다 |
| `<title>`·`og:site_name` 에 상호 | +30 | |
| 도메인 레이블이 상호와 겹침 | +15 | 한글 상호에서는 거의 발화하지 않는다 |
| 시군구 일치 | +10 | |
| 자체 도메인 (임대형 빌더 아님) | +10 | |
| 연락처·소개 경로 존재 | +5 | |
| https | +3 | |
| 임대형 빌더 | −10 | `modoo.at` 등. **배제가 아니라 감점** |
| 껍데기 페이지 | −20 | 텍스트 80자 미만 **그리고** 링크 5개 미만 |

`≥65 confirmed` · `≥40 likely` · 그 외 `uncertain`. 상태 의미를 섞지 않는다:

- **`not_official`** — 아니라는 **증거**가 있다 (애그리게이터·SNS·공유 도메인·공유 본문)
- **`uncertain`** — 증거가 **없다**
- **`unavailable`** — 확인 자체를 **못 했다** (URL 없음·robots 차단·fetch 실패)

가중치는 골드셋 검증 전의 초기값이다. 설계서 M2(정밀도 ≥0.90 / 재현율 ≥0.75)를 표본으로
측정한 뒤 조정한다.

### 실측으로 드러난 방어 — DNS NXDOMAIN 하이재킹

로컬 실행 중 확인했다. 국내 ISP 는 존재하지 않는 도메인을 **자사 안내 페이지 IP 로 응답**한다
(KT: 모든 미등록 도메인 → `121.78.127.249`). 그러면 폐업해서 도메인이 사라진 업체의 홈페이지도
"살아 있고 200 을 주는 사이트" 로 보인다. 도메인은 전부 다르므로 공유 도메인 규칙에 걸리지 않는다.

잡히는 지점은 **본문이 똑같다**는 것뿐이다. `contact_pages` 스테이지가 실행 단위로
`content_hash` 를 모아, 서로 다른 사이트 3곳 이상이 같은 본문을 주면 전부 `not_official` 로
강등한다. (2곳은 강등하지 않는다 — 한 업체가 `example.co.kr` · `example.kr` 로 같은 사이트를
서비스하는 것은 정상이다.)

### 채널 활성도 — 네이버 없이 성립하는 축

설계서 3절이 "ORS 없이 성립하는 축소 파이프라인을 1급 경로로 유지한다" 고 정한 축이 이것이다.
그래서 **네이버 승인 여부와 무관하게** 동작해야 하고, 실제로 외부 API 키를 하나도 쓰지 않는다.

- 채널은 **검색으로 찾지 않는다.** 공식으로 판정된 홈페이지가 스스로 링크한 주소만 인정한다.
  검색으로 찾으면 동명이인·팬페이지를 공식으로 오인하고 쿼터도 쓴다. 링크는 `homepage_detect`
  가 이미 받아 둔 것이라 **추가 요청이 0회**다.
- 유튜브는 Data API 대신 **공개 RSS 피드**(`feeds/videos.xml`)를 쓴다. 키도 쿼터도 필요 없고
  "최근 발행이 없다" 는 신호를 그대로 준다. 설계서 4.1 은 `channels.list`(1 unit)를 적었지만
  활성도 산출에는 불필요하다.
- 판정은 **낮은 쪽에서만 정확하면 된다.** 찾는 것이 "최근에 아무것도 안 올린 곳" 이므로,
  피드가 관측 창을 못 덮으면 `feed_saturated` 로 표시하고 카운트를 **하한값**으로 다룬다.

분석할 수 없는 채널(인스타그램·유튜브 핸들 주소·브런치)은 **사유를 남긴다.** 추측한 피드
주소로 요청을 보내지 않는다.

### ORS — 배점 0 의 shadow feature

`FEATURE_ORS` 는 3-state 다. 기본값 `off` 에서는 어댑터가 **아예 로드되지 않고**,
`search_analyze` 는 실패가 아니라 건너뛴다.

| 값 | 전제 조건 | ORS 산출 | 배점 |
|---|---|---:|---:|
| `off` (기본) | 없음 | ❌ | 0 |
| `shadow` | `source_registry.approved` + 서면 근거 | ✅ 기록만 | 0 |
| `on` | 위 + Phase 4 확증 검증(n=240) 통과 | ✅ | 25 |

분모는 채널마다 `min(30, total, 실제 회수 건수)`다. 고정 30 을 쓰면 결과가 10건뿐인 채널을
부당하게 낮게 평가하고(R2-09), 보지 못한 결과를 분모에 넣으면 **없는 공백을 만들어 낸다.**
분모가 0 이면 ORS 는 0 이 아니라 **정의되지 않음**(null)이다 — 아무도 콘텐츠가 없는 키워드는
점유 공백을 재는 데 쓸 수 없다.

브랜드와 비브랜드는 **합산하지 않는다.** 상호로 검색하면 당연히 본인 콘텐츠가 잡히므로
섞으면 점유율이 부풀려진다.

### 쿼터 가드

호출한 뒤에 세지 않고 **호출하기 전에 원장에 적는다.** 워커가 호출 직후 죽으면 "썼는데 세지
않은" 호출이 생기고, 재시도하면 실제 사용량이 한도를 넘는다. 과다 계상은 하루치 여유를 조금
잃을 뿐이지만 과소 계상은 계정 차단으로 이어진다 — 안전한 쪽으로 틀린다.

`cost_ledger.entry_key` 가 unique 라 잡 재시도가 쿼터를 갉아먹지 않고, provider 단위 advisory
lock 으로 동시 선점이 한도를 넘지 못한다. 한도에 닿으면 그 자리에서 멈추고 실행을 `partial`
로 끝낸다 — 조용히 줄여서 계속하지 않는다.

### 3축 점수 — 하나의 잠재변수를 세 번 재지 않는다

v1 은 검색공백 35 + 콘텐츠부족 15 + 경쟁격차 20 = **70점이 전부 "온라인 활동량이 적다"** 였다.
같은 것을 세 번 재면 총점 60이 독립적인 품질 경계라는 근거가 없고, 점수가 임계값 근처에
인위적으로 군집한다(F-21). v2 는 축을 분리하고 **축별 하한**을 함께 둔다.

| 축 | 만점 (모드 B) | 하한 | 내용 |
|---|---:|---:|---|
| 문제 크기 | 27 | 15 | 경쟁사 격차 12 + 최근 콘텐츠 활동 부족 15 (ORS 25는 배점 0) |
| 구매 가능성 | 25 | 10 | 사업성 10 + 예산 신호 10 + 접점 품질 5 |
| 데이터 신뢰도 | 15 | 9 | 공식 판정 5 + 분석 완료 비율 5 + 경쟁사·신선도 5 |

총점은 **100점 환산**으로 판정한다 — 모드 B 만점이 67 이므로 요구사항의 "60점" 을
`total/67×100 >= 60` 으로 읽는다.

**축 하한과 총점을 함께 두는 이유**: 하한은 *필요조건*(한 축 몰빵 방지), 총점은
*충분조건*(모든 축이 하한만 겨우 넘는 약한 후보 차단)이다.

### ❗ 측정하지 못한 것을 0점으로 세지 않는다

이 규칙이 이 단계에서 가장 중요하다. 결측을 0으로 바꾸면 **우리 수집 실패가 상대의
취약점이 되고**, 그 업체가 리드로 올라간다.

- 유효 경쟁사 2곳 미만 → 격차 항목을 `unavailable` 로 두고 **만점에서도 뺀다.**
  **재정규화하지 않고** 게이트에서 탈락시킨다 (설계서 A.6).
- 피드를 가져오지 못한 채널 → 활동량을 0 으로 단정하지 않는다. 취약점도 발화하지 않는다.
- 채널이 **아예 없는 것**은 관측 실패가 아니라 부재다 — 이건 만점을 준다.

### 예산 신호는 상호작용 규칙이다 (A.3)

마케팅 활발을 무조건 가점하면 **이미 잘 되는 업체가 좋은 취약 리드로** 바뀐다.

```
마케팅 활발 + 경쟁사 대비 명확한 격차  → 10  ✅ 예산은 있는데 뒤처짐 — 최우선
마케팅 활발 + 격차 없음               →  2  ❌ 이미 경쟁사 수준 — 교체 설득 어려움
마케팅 약함 + strong 취약점           →  6  △ 예산 불확실하나 문제가 큼
그 외                                 →  3
```

v2 는 조건을 `axis_problem < 32` 로 걸었는데 게이트 통과 후보는 정의상 그 위여서
**dead code** 였다(R2-11). v3 는 `clear_gap` 으로 바꿨다 — 게이트의 필수 조건이 아니라
실제로 변별력이 있다.

### 경쟁사는 검색으로 뽑지 않는다

검색으로 뽑으면 이미 검색에 잘 나오는 업체만 경쟁사가 되고, 그러면 **모든 대상이
"경쟁사보다 뒤처짐"** 으로 보인다. 선택편향이 그대로 허위 취약점이 된다.
대신 업종·지역·규모 매칭으로 고르고, 같은 `group_id`(다지점·동일 네트워크)는 제외한다.

> ⚠️ **콜드 스타트**: 경쟁사 지표는 그 업체가 이미 분석된 적 있어야 나온다. 초기 실행에서는
> 유효 경쟁사가 부족해 대부분이 `competitor_gap_unavailable` 로 탈락한다. 누적 실행이
> 모집단을 훑으면 해소된다 — 결론 E 의 "7~21건/일" 이 이 warm-up 을 반영한 값이다.

### 추천은 규칙이 고른다

`검색 점유·SEO 콘텐츠` → `매체 광고` → `콘텐츠 마케팅` → `홈페이지 개선` 우선순위로,
가장 큰 문제 항목에서 주력 1개, 차순위에서 보조 최대 2개를 고른다.
**언어 모델은 선정이 아니라 문장 정리에만 쓴다** — `FEATURE_LLM=off` 로 전체가 동작한다.

## 검수 API (Phase 6)

```
GET  /api/review              검수 후보 목록
GET  /api/review/:id          상세 + 1회용 nonce 발급
POST /api/review/:id/contact-email   연락처 수동 입력 → 문법·DNS·MX
POST /api/review/:id/decision        승인·제외 (승인은 emailId 필수)
POST /api/review/bulk-decision       일괄 **제외만**
GET  /api/leads · /api/leads/export  목록 · export(admin 전용)
```

`pnpm api` 로 띄운다. `API_DATABASE_URL` · `SUPABASE_JWT_SECRET` 이 필요하다.

### UI 연동 — 토큰은 브라우저에 내려가지 않는다

```
브라우저 → taimen /api/gateway/* (Next 라우트 핸들러) → 검수 API
```

프록시를 두는 이유가 셋이다.

1. **토큰이 클라이언트에 없다.** localStorage 나 번들에 두면 XSS 하나로 검수 권한이 유출된다.
2. CORS 가 필요 없다 — 브라우저에서 보면 같은 출처다.
3. Supabase Auth 를 붙일 때 고칠 곳이 `src/lib/server/token.ts` 하나다.

프록시는 경로를 **허용 목록**으로 좁힌다. 열어 두면 이 핸들러가 API 전체에 대한 통로가 된다.

```bash
# 검수 API
API_DATABASE_URL=... SUPABASE_JWT_SECRET=... API_PORT=8792 pnpm api

# UI (taimen/)
LEADOPS_API_URL=http://127.0.0.1:8792 SUPABASE_JWT_SECRET=... LEADOPS_DEV_LOGIN=1 LEADOPS_DEV_USER_ID=<profiles.id> pnpm dev
```

> ⚠️ **`LEADOPS_DEV_LOGIN` 은 인증이 아니라 인증의 자리표시자다.** Supabase Auth 프로젝트가
> 없어서 서버가 직접 토큰을 만든다. `NODE_ENV=production` 이거나 플래그가 없으면
> `401 auth_unavailable` 로 **거부한다** — 조용히 폴백하지 않는다.

### ❗ 낙관적 갱신을 하지 않는다

승인은 일 상한(409)·업종 쿼터(409)·MX 미통과(422)·nonce 만료(403)로 거절될 수 있다.
화면이 먼저 "승인"으로 바꿔 두면 **실패한 승인이 성공처럼 보인다.** 서버가 확인해 준 뒤에
목록을 다시 읽는다. 거절 사유는 코드와 함께 화면에 띄운다.

이것이 첫 리뷰에서 지적한 **일 상한·업종 쿼터 미강제** 문제의 해소 방식이다 — UI 가 상한을
직접 세지 않고, DB 가 세고 API 가 옮기고 UI 는 결과를 보여 준다.

### ❗ 모르는 값을 0 으로 채우지 않는다

백엔드가 지키는 원칙(설계서 A.6)이 UI 에서 무너지면 검수자가 잘못 판단한다.

| 값 | API 가 모를 때 | 화면 |
|---|---|---|
| 경쟁사 ORS·활동량 | `null` | `—` (0 이 아니다) |
| 경쟁 중앙값 | `null` | `—`, 격차 % 도 계산하지 않는다 |
| 실행 ID·비용·쿼터 | 엔드포인트 없음 | `—` (fixture 숫자를 섞지 않는다) |
| 분석되지 않은 경쟁사 | `is_valid=false` | 흐리게 + 사유 툴팁 |

### 규칙은 API 를 통과해도 유지된다

API 는 **입력을 옮기고 결과를 옮길 뿐**이다. 상한·쿼터·게이트·nonce·rate limit 은 전부
DB 안에 있고, API 를 우회해도 유지된다. 통합 테스트가 그것을 확인한다 — 일 상한을 2로
낮추고 API 로 승인을 시도하면 `409 daily_cap_reached` 가 온다.

### ❗ MX 검증 결과는 사용자가 쓸 수 없다

`decide_review_item` 은 `mx_ok is true` 를 요구한다. 그런데 Supabase 모델에서
`authenticated` 는 브라우저에서 RPC 를 직접 호출할 수 있으므로, MX 기록 함수를 그 역할에
주면 **검수자가 스스로 게이트를 통과시킬 수 있다.**

그래서 `verify_contact_email` 은 `service_role` 에만 실행권을 준다(마이그레이션 0010).
API 서버가 직접 DNS 를 조회한 뒤 서버 권한으로 기록한다. 스키마 린트와 통합 테스트가
`authenticated` 에 실행권이 없음을 확인한다.

### JWT 는 직접 검증한다

라이브러리 대신 HS256 검증을 직접 하고, **공격 케이스를 테스트로 고정**한다 —
`alg: none`·`alg` 바꿔치기·서명 위조·페이로드 변조·만료·`nbf`·비 UUID `sub` 가 전부 막힌다.
서명 비교는 `timingSafeEqual` 이고, `sub` 는 그대로 RLS 의 `auth.uid()` 가 되므로
UUID 가 아니면 거절한다.

### SMTP 는 쓰지 않는다

문법 → DNS → MX 까지만 본다 (설계서 1.6). 상대 서버에 붙어 수신자 존재를 떠보는
프로빙은 하지 않는다. MX 가 없으면 A/AAAA 로 implicit MX(RFC 5321)를 인정하되 신뢰도를
낮게 기록한다 — 엄격하게 MX 만 요구하면 실제로 메일이 가는 도메인을 탈락시킨다.
`.` 하나만 오는 null MX(RFC 7505)는 **거부**한다. 메일을 받지 않겠다는 선언이다.

## 아직 없는 것

Playwright E2E · 실행/설정/업종/비용/개인정보 엔드포인트 · Supabase Auth ·
스케줄러(pg_cron) · 개인정보 워크플로 · Outreach(발송 상태) 모듈.

UI 에서 아직 fixture 를 쓰는 화면: `/runs` · `/industries` · `/settings`
(해당 엔드포인트가 없다). `/today` 와 `/leads` 는 실데이터다.
검색 결과물 목록(`search_hits`)은 API 가 노출하지 않아 드로어의 SignalStream 이 비어 있다.

다음은 **taimen 을 API 에 연결하는 일**이다. UI 는 fixture 모드로 이미 있으므로
`store.tsx` 의 전이 함수를 위 엔드포인트 호출로 바꾸면 된다. 이때 taimen 의
**일 상한·업종 쿼터 미강제** 문제도 함께 해소된다 — 지금은 표시만 하지만, API 를 붙이면
DB 가 `409` 를 돌려주므로 그 상태를 화면에 옮기기만 하면 된다.

다만 **Phase 2~5 의 완료 기준이 아직 미측정**이다 — 골드셋 120건이 없어
M2(공식 판별 정밀도 ≥0.90) · M3(연락처 후보 적중률 ≥50%) · M6(ORS 산출 가능률 ≥90%) ·
점수 가중치 보정을 재지 못했다. `pnpm spike sample` 이 라벨링용 CSV 를 뽑아 준다.

## 스크립트

| 명령 | 설명 |
|---|---|
| `pnpm verify` | typecheck + 단위 + DB 테스트 |
| `pnpm typecheck` | TypeScript strict 검사 |
| `pnpm test` | 단위·통합 테스트 (DB 불필요) |
| `pnpm test:db` | DB 통합 테스트 (Postgres 필요) |
| `pnpm test:watch` | 감시 모드 |
| `pnpm db:up` / `db:down` | 테스트용 Postgres 컨테이너 기동·정지 |
| `pnpm db:psql` | 컨테이너 psql 접속 |
| `pnpm db:migrate [--bootstrap]` | 마이그레이션 적용 |
| `pnpm worker run --industry=derm,dental` | 실행 하나를 만들고 끝까지 처리 |
| `pnpm worker worker` | 큐를 계속 비운다 (상시 실행) |
| `pnpm worker reap` / `cleanup` | lease 회수 / 보존기간 정리 |
| `pnpm spike verify` | **어댑터 실 API 검증** (키 필요) — 엔드포인트 탐색·코드값 검사·fixture 녹화 |
| `pnpm spike <cmd>` | 스파이크 CLI (`universe` / `sample` / `help`) |
