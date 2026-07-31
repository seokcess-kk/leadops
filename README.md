# LeadOps — Outbound Lead Finder

마케팅 에이전시 내부용 리드 발굴 도구. 검색 수요는 있으나 검색 결과물·콘텐츠 점유가
경쟁사보다 부족한 업체를 찾아 영업 가치가 높은 리드만 선별한다.

> **현재 상태: Phase 7 대부분 완료 (스케줄러·용량·개인정보 집행·복구 리허설)**
> 설계서 `docs/00-plan.md` v3 기준. Phase 6 은 닫혔다(E2E 13건). Phase 7 에서 남은 것은
> **파티셔닝**과 **평일 06:00 3영업일 연속 성공**(달력이 필요하다)이다. Phase 2~5 의 완료
> 기준(골드셋 M2·M3·M6)은 여전히 미측정이다. 운영 절차는 [`docs/07-runbook.md`](docs/07-runbook.md).

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
| [`docs/07-runbook.md`](docs/07-runbook.md) | **운영 런북** — 배포·스케줄러·용량·개인정보 처리·백업/복구 |
| [`docs/08-goldset-labeling.md`](docs/08-goldset-labeling.md) | **골드셋 라벨링 기준** — 열별 판정 기준·측정·Phase 0 게이트 |
| `docs/critique/` | codex 원본 비평 보존 |

## 빠른 시작

```bash
pnpm install
cp .env.example .env      # 목업 모드로 바로 동작한다

pnpm db:up                # 테스트용 Postgres 17 컨테이너 (Docker 필요)
pnpm verify               # typecheck + 633 단위 + 242 DB 테스트

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
taimen/             검수 콘솔 UI (Next.js 16 · 실데이터 · 독립 pnpm 워크스페이스)
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
| `0011_admin_rpcs` | 실행 취소·재시도 · 키워드 승인 · 경쟁사 교체 · 개인정보 접수 |
| `0012_ops_privacy_capacity` | 개인정보 **집행** · 용량 게이트 · 스케줄 판정 |
| `0013_fix_setting_paths` | **결함 수정** — `settings` 단일 행에 중첩 jsonb 경로를 쓴 곳 (아래) |
| `0014_homepage_discovery` | 홈페이지 발견 스테이지 — `websites.discovery_source`·`discovery_basis` |
| `0015_partition_observations` | 관측 4테이블 월 파티션 · `run_date` 키 · 365일 detach→drop |

`packages/db/migrations/deploy/` 는 **체인에 없다.** `pg_cron_schedule.sql` 은 pg_cron·pg_net 이
있는 배포 대상에만 적용한다 (로컬 컨테이너에 확장이 없어 검증할 수 없다).

### ⚠️ 0013 이 고친 결함 — 설정이 조용히 무시되고 있었다

`settings` 는 키 하나에 그 키의 객체만 담는다(`key='review'`, `value={"nonce_ttl_minutes":30,…}`).
그런데 세 함수가 `value #>> '{review,nonce_ttl_minutes}'` 처럼 **키를 한 번 더** 타고 들어갔다.
그 경로는 항상 NULL 이고 전부 `coalesce(…, 기본값)` 으로 감싸져 있어서 **조용히 기본값으로
동작**했다 — 값을 바꿔도 아무 일이 일어나지 않는다.

| 설정 | 영향 |
|---|---|
| `review.manual_email_per_minute` | 이메일 수동 입력 **rate limit 을 조일 수 없었다** (보안 통제) |
| `review.nonce_ttl_minutes` | 검수 화면 nonce 유효 시간을 바꿀 수 없었다 |
| `export.max_per_lead` | 리드당 export 횟수 상한을 바꿀 수 없었다 (항상 3) |

시드 값이 코드 기본값과 같아서(3·30·3) 기존 테스트도 통과했다. `ops.pg.test.ts` 는
"저장된다" 가 아니라 **"바꾼 값이 실제로 동작을 바꾼다"** 를 검증한다.
`runs.settings_snapshot` 을 읽는 곳(`decide_review_item`)은 정상이었다 — 스냅샷은
`snapshot_settings()` 가 키로 묶은 객체라 중첩 경로가 맞다.

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
| `FtcFranchiseAdapter` | ❌ **미검증 · 진단 불가** (2026-07-30 실키로 재확인) | 후보 전부 500 인데 **음성 대조군도 같은 500** — 경로 추측이 무의미하다. **공정위 가맹정보** 데이터셋 가이드 문서의 요청주소가 필요 (HIRA 가이드에는 없음) |
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
homepage_discover                competitor_select   업종·지역·규모 매칭 (검색 아님)
  │  URL 없는 업체만 · 지역검색 ·      │
  │  전화/상호+지역 일치만 채택        │
  ↓                                  │
homepage_detect                      │
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

### 홈페이지 발견 — 판정보다 먼저, 그러나 판정을 대신하지 않는다

`hospUrl` 이 **실측 20.8%** 만 채워져 있어(2026-07-30 · 표본 900건) 나머지는 평가할 URL
자체가 없다. `homepage_discover` 가 지역검색으로 후보를 찾아 채우되, **검색 결과를 그대로
믿지 않는다.**

| 근거 | 판정 |
|---|---|
| 전화번호 일치 | 채택 (강한 근거) — 공공 API 대표번호와 같으면 그 업체다 |
| 상호 + 시군구 **동시** 일치 | 채택 (약한 근거) |
| 그 외 | **거절** |

상호만 맞으면 동명이인이고 지역만 맞으면 옆 건물 다른 병원이다. 애그리게이터·SNS 링크는
**요청 전에** 자른다. 검색 순위는 그 업체 것이라는 근거가 아니므로 순위로 고르지 않는다.

발견은 **후보를 만들 뿐**이고 공식 여부는 위의 다신호 판정이 그대로 정한다. 그래서
`homepage_discover` → `homepage_detect` 순서다 — 뒤바뀌면 "검색이 찾았으니 공식" 이 된다.
어디서 온 URL 인지는 `websites.discovery_source` · `discovery_basis` 에 남는다 (1차 수집원은
`null`). 남기지 않으면 오분류가 나왔을 때 어느 쪽 문제인지 구분할 수 없다.

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
POST /api/review/:id/competitors     경쟁사 수동 지정
GET  /api/leads · /api/leads/export  목록 · export(admin 전용)

GET  /api/runs · /api/runs/:id       실행 이력 · 상세(스테이지·실패 잡·비용)
POST /api/runs                       수동 실행 (admin · dryRun 지원)
POST /api/runs/:id/retry · /cancel   스테이지부터 재실행 · 취소 (admin)
GET  /api/settings                   설정 9키 + 파서 통과 적용값(effective)
PUT  /api/settings/:key              키 통째 덮어쓰기 (admin · 화이트리스트)
GET  /api/costs                      일별·제공자별 비용 · 상한 (admin 전용)
GET  /api/industries                 업종별 업체·공식 홈페이지·키워드·리드·쿼터
GET  /api/keywords · POST /:id/approve   업체 키워드 · 승인 (admin)
GET  /api/privacy/requests · POST    개인정보 요청 접수(user)·목록(admin)
POST /api/privacy/requests/:id/advance         상태 전이 (admin · 보류·거절은 사유 필수)
POST /api/privacy/requests/:id/access-report   열람 보고서 (admin · 조회가 감사 기록된다)
POST /api/privacy/requests/:id/execute         삭제·처리정지 **집행** (admin · 되돌릴 수 없다)
GET  /api/capacity                   DB 용량·테이블별 크기 (admin)

POST /internal/run                   pg_cron 트리거 (HMAC 서명 · JWT 없음)
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

`taimen` 은 **상위 워크스페이스에 속하지 않는다** (`taimen/pnpm-workspace.yaml` 이 경계다).
루트에서 `pnpm install` 해도 UI 의존성은 깔리지 않으므로 `taimen/` 안에서 따로 설치한다.

```bash
# 0) 로컬 검증용 DB
pnpm db:up
DATABASE_URL=postgres://postgres:leadops@127.0.0.1:55432/leadops pnpm db:migrate --bootstrap

# 1) 검수자 계정 — auth.users 에 넣으면 트리거가 profiles 를 만든다
#    insert into auth.users (id, email) values ('<uuid>', '<이메일>');
#    update public.profiles set role = 'admin' where id = '<uuid>';   -- 비용·설정·실행은 admin 전용

# 2) 워커 (leadops_worker 역할로 접속한다 — 로컬에서는 password 를 직접 부여)
#    alter role leadops_worker with login password '<pw>';
WORKER_DATABASE_URL=postgres://leadops_worker:<pw>@127.0.0.1:55432/leadops \
DATABASE_URL=... FEATURE_SOURCE=mock pnpm worker run --industry=derm,dental

# 3) 검수 API
API_DATABASE_URL=... SUPABASE_JWT_SECRET=... API_PORT=8792 pnpm api

# 4) UI (taimen/ 안에서)
pnpm install
LEADOPS_API_URL=http://127.0.0.1:8792 SUPABASE_JWT_SECRET=... \
LEADOPS_DEV_LOGIN=1 LEADOPS_DEV_USER_ID=<profiles.id> pnpm dev
```

> `127.0.0.1:3000` 이 아니라 **`localhost`** 로 접속한다. Next 16 은 `127.0.0.1` 에서 온
> HMR 요청을 cross-origin 으로 막아 핫리로드가 죽는다 (`allowedDevOrigins`).

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

## E2E (Playwright · `apps/e2e`)

```bash
pnpm db:up
pnpm e2e:install     # chromium 최초 1회
pnpm e2e
```

13개 테스트가 설계서 10절 Phase 6 완료 기준을 덮는다.

| 파일 | 검증 |
|---|---|
| `01-review.spec.ts` | 검수 목록 → 연락처 근거로 이메일 입력 → **실제 DNS·MX** → 승인 → 리드 → export(워터마크·감사 로그·`export_count`) |
| `02-caps.spec.ts` | 일 승인 상한 `409 daily_cap_reached` · 업종 비율 `409 industry_quota_exceeded` · 상한이 화면 카운터에 그대로 |
| `03-xss.spec.ts` | 업체명 XSS 페이로드가 텍스트로만 렌더링 (주입 노드 부재 · `dialog` 미발생) |
| `04-keyboard.spec.ts` | `j/k` 이동 · `Space` 선택 · `Enter` 상세 · `e` 이메일 포커스 · `x`→숫자키→`Enter` 제외 · `Esc` 취소 · **일괄 승인 경로 부재** |

이 하네스가 지키는 것:

- **격리 데이터베이스.** `createTestDb` 로 실행마다 새로 만들고 teardown 이 DB 와 워커 역할까지
  지운다 (역할은 클러스터 전역이라 남기면 쌓인다). 개발용 DB 를 건드리지 않는다.
- **MX 는 흉내 내지 않는다.** 승인 게이트의 핵심이라 가짜 리졸버로 통과시키면 검증한 것이
  아니다. 그래서 **네트워크가 필요하다** — 도메인은 `LEADOPS_E2E_MX_DOMAIN` 으로 바꿀 수 있다.
- **`workers: 1` · `retries: 0`.** 검증 대상이 공유 상태(승인 카운터)이고 그 전이 자체가 규칙이다.
  재시도는 실패를 감추고, 승인은 되돌릴 수 없다.
- **후보는 fixture 로 만든다.** mock 파이프라인은 홈페이지가 실재하지 않아 게이트 통과 후보가
  0 이다 (콜드 스타트). 통합 테스트와 같은 `@leadops/db` fixture 를 쓴다.

> ⚠️ `taimen` 에서 개발용 `next dev` 가 돌고 있으면 E2E 가 실패한다. Next 는 **디렉터리 단위**로
> 두 번째 dev 인스턴스를 거부한다(포트가 달라도). globalSetup 이 이 사유를 에러에 적어 준다.

> ⚠️ 상한은 `runs.settings_snapshot` 에서 읽힌다 (`decide_review_item` · R2-19). live `settings`
> 만 바꾸면 진행 중 실행의 판정은 바뀌지 않는다 — 의도된 설계이고, E2E 는 두 곳을 함께 바꾼다.

**설계서 완료 기준과 다르게 한 것**: "동시 승인 51번째 거부" 를 상한 1 로 낮춰 검증한다.
51행은 규칙이 아니라 숫자를 검증하는 것이고, 행 잠금 **직렬화**는 브라우저로는 검증할 수 없다 —
그쪽은 `rpc.pg.test.ts` 가 동시 트랜잭션으로 본다. E2E 는 **화면까지 도달하는 경로**를 본다.

## 운영 (Phase 7)

절차는 [`docs/07-runbook.md`](docs/07-runbook.md). 코드가 강제하는 것만 여기 적는다.

```bash
pnpm worker schedule --dry-run   # 스케줄 판정만 (평일·중복·용량)
pnpm worker schedule             # 조건 충족 시 cron 실행 생성
pnpm worker capacity             # 용량·레벨 (block 이면 종료 코드 1)
pnpm worker cleanup              # 용량 인식 정리
pnpm worker reap                 # 만료 lease 회수
scripts/restore-rehearsal.sh     # 백업·복구 리허설
```

**스케줄 판정은 cron 표현식에 없다.** pg_cron 은 "부를 시각" 만 알고, 평일(KST)·중복·용량은
`should_start_scheduled_run()` 이 판정한다. 주말에 불려도 실패가 아니라 `skipped` 다.

**용량 임계값** (설계서 4.2 — Free 500MB 로는 180일을 못 버틴다):

| 레벨 | 임계 | 동작 |
|---|---|---|
| `warn` | ≥ 70% | 알람 |
| `cleanup` | ≥ 85% | 정리 잡이 보존기간을 줄인다 (관련 문서 30→7일, 집계·관측 365→120일) |
| `block` | ≥ 90% | **신규 실행 차단** — `startRun` 이 `capacity_exceeded` 로 실패한다 |

**개인정보**: 접수만 되던 워크플로에 **집행**이 붙었다. `delete` 는 이메일을 파기하고
`do_not_contact` 로 영구 차단한다 — 업체 행 자체는 지우지 않는다(지우면 재수집 대상이 되어
다시 올라온다). `legal_hold` 는 삭제를 막고 사유를 남긴다. 기한은 접수 시점에 10일로 못 박힌다.

## 아직 없는 것

Supabase Auth · Outreach(발송 상태) 모듈.

UI 는 fixture 를 쓰지 않는다. `/today` · `/leads` · `/runs` · `/industries` · `/settings`
가 전부 실데이터다 (fixture 는 `NEXT_PUBLIC_LEADOPS_DATA_SOURCE=fixture` 개발 모드에만 남아
있고, 그 모드에서 `/runs`·`/industries`·`/settings` 는 검수 API 가 필요하다고 화면에 밝힌다).

**API 가 줄 수 없어서 화면이 `—` 로 두는 것들** — 0 으로 채우지 않는다:

| 값 | 왜 없는가 | 채우려면 |
|---|---|---|
| 퍼널 상단 (수집 후보 · 상세 분석) | `runs.counts` 가 선언만 되어 있고 **파이프라인이 쓰지 않는다** (항상 `{}`) | 오케스트레이터가 `counts` 를 갱신하거나, 실행별 집계 엔드포인트를 추가 |
| 오늘 제외 건수 | `/api/review` 목록에 `decided_at` 이 없어 오늘분을 가려낼 수 없다 (누적값은 오늘 값이 아니다) | 목록 select 에 `ri.decided_at` 추가 |
| 검색 결과물 목록 (드로어 SignalStream) | `search_hits` 를 API 가 노출하지 않는다 | 상세 응답에 추가 |
| 사이드바 사용자·역할 | `/api/me` 가 없어 하드코딩이다 | 프로필 엔드포인트 추가 |
| 실행별 네이버 쿼터 | `cost_ledger` 는 **일 단위 원장**이라 실행 단위 사용량이 없다 | 원장에 `run_id` 기준 집계를 노출하거나 실행별 쿼터를 기록 |

비용·쿼터는 `/api/costs` 가 **admin 전용**이다. 검수자 권한으로 보면 `—` 이고, 이건 "0 원"과
다르다 — 권한이 없어서 못 본 것이다.

`/api/runs/:id` 는 스테이지를 **알파벳 순**(`order by s.stage`)으로 준다. DAG 순서를 아는 곳은
UI 뿐이라 `types.ts` 의 `stageRank()` 가 다시 정렬한다 — 정렬하지 않으면 `channel_analyze` 가
`collect` 보다 앞에 와서 실행 순서를 오독한다.

다만 **Phase 2~5 의 완료 기준이 아직 미측정**이다 — 골드셋 120건이 없어
M2(공식 판별 정밀도 ≥0.90) · M3(연락처 후보 적중률 ≥50%) · M6(ORS 산출 가능률 ≥90%) ·
점수 가중치 보정을 재지 못했다.

### ❗ 실측된 것 (2026-07-30 · 실키 · 표본 90건 · 시드 42)

라벨 없이 측정 가능한 지표만. 나머지는 `미측정` 이다.

| 지표 | 실측 | 기준 | 판정 |
|---|---:|---:|---|
| **M1 홈페이지 발견률 (우리)** | **18.9%** `[12.1%, 28.2%]` | ≥ 70% | ❌ **명백한 미달** |
| M6 ORS 산출 가능률 | 0.0% `[0.0%, 4.1%]` | ≥ 90% | `FEATURE_ORS=off` 라 정의상 0 |

**표본 90건이 파이프라인을 어디까지 통과했는가**

| 단계 | 건수 |
|---|---:|
| 표본 | 90 |
| URL 확보 (`hospUrl`) | **17** |
| 관측 완료 | 17 |
| **공식 판정 (confirmed·likely)** | **3** |
| 연락처 페이지 후보 | 3 |
| 채점 | 17 |
| 검수 후보 | **0** |

> **M1 이 병목이다.** HIRA 의 `hospUrl` 이 19% 만 채워져 있어 나머지 81% 는 판정 자체를
> 하지 못한다(`no_homepage_url`). 그 뒤 단계는 전부 이 17건 위에서만 돌아간다 —
> 공식 판정 3건, 연락처 후보 3건, 검수 후보 0건. **소스 보강 없이는 M2·M3 를 잴 표본
> 자체가 부족하다** (판정 3건으로는 정밀도 ≥0.90 을 검증할 수 없다).
>
> 검수 후보 0 은 콜드 스타트이기도 하다 — 유효 경쟁사가 2곳 미만이면 게이트에서 탈락한다
> (설계서 A.6). 누적 실행이 모집단을 훑으면 해소되는 부분이다.

**대응 — `homepage_discover` 스테이지를 넣었다** (설계서 9.1 의 M1 미달 대응 = "소스 보강").

`hospUrl` 이 없는 업체에 대해 **지역검색**으로 후보 URL 을 찾는다. 다만 검색 결과를 그대로
믿지 않는다 — 이 저장소는 채널 발견에서 검색을 쓰지 않는데, 같은 이유(동명이인·팬페이지
오인)가 홈페이지에도 그대로 적용되기 때문이다.

| 근거 | 판정 |
|---|---|
| 전화번호 일치 (공공 API 대표번호와 같다) | **채택** — 강한 근거 |
| 상호 + 시군구 **동시** 일치 | **채택** — 약한 근거 |
| 그 외 | **거절** — 추측하지 않는다 |

- 상호만 맞으면 동명이인, 지역만 맞으면 옆 건물 다른 병원이다. **둘 다** 맞아야 한다
- 애그리게이터·SNS 링크는 **요청 전에** 자른다 (지역검색 `link` 는 플레이스·블로그인 경우가 흔하다)
- 검색 순위가 높다는 이유로 고르지 않는다 — 순위는 그 업체 것이라는 근거가 아니다
- 발견은 **후보를 만들 뿐**이다. 공식 여부는 기존 다신호 판정(전화 +35 · `<title>` +30 …)이
  그대로 정한다. 스테이지 순서가 `homepage_discover` → `homepage_detect` 인 이유다 —
  뒤바뀌면 "검색이 찾았으니 공식" 이 되어 판정이 무력해진다
- 어디서 온 URL 인지 `websites.discovery_source`·`discovery_basis` 에 남긴다. 남기지 않으면
  골드셋에서 오분류가 나왔을 때 1차 수집원 문제인지 발견 문제인지 구분할 수 없다
- 쿼터는 ORS 와 **합산**(일 25,000회)이고 호출 전에 선점한다
- 어댑터가 없으면(`FEATURE_ORS=off`) 실패가 아니라 건너뛴다 — 축소 파이프라인이 1급 경로다

> ⚠️ **아직 실측되지 않았다.** 네이버 자격증명이 없어 실제 발견율을 재지 못했다.
> 매칭 규칙과 스테이지 동작은 테스트로 고정했지만(단위 21 · 통합 8), **M1 이 실제로
> 얼마나 오르는지는 자격증명 확보 후 재측정해야 한다.**

**측정 하네스는 준비돼 있다** (`pnpm spike measure`). 남은 것은 코드가 아니라 입력이다:

| 필요한 것 | 없으면 |
|---|---|
| ~~공공데이터포털 키~~ | ✅ 확보 · HIRA 실응답 검증 완료 (2026-07-30) |
| **사람의 라벨링 8~12시간** (90건) | 라벨 의존 지표가 전부 `미측정` |
| **네이버 자격증명 + `FEATURE_ORS=shadow`** | M7(**stop 게이트**)을 못 잰다 → 판정이 계속 `미판정` |
| **공정위 가맹정보 요청주소** | 프랜차이즈 30건을 못 뽑는다 → 골드셋이 90건(3업종)이다 |

```bash
FEATURE_SOURCE=live pnpm spike sample --per-industry 30 --seed 42
pnpm worker run --industry=derm,plastic,dental,franchise   # 같은 표본으로 파이프라인 실행
#   → out/sample-seed42.csv 의 label_* 열을 채운다 (docs/08-goldset-labeling.md)
pnpm spike measure --goldset out/sample-seed42.csv
```

하네스가 지키는 것:

- **라벨이 없는 지표는 숫자를 만들지 않는다.** 빈 라벨을 `no` 로 읽으면 라벨링을 덜 한 것이
  성적으로 바뀐다 — `미측정` 으로 보고한다
- 비율은 **점추정 + Wilson 95% CI**. 가설검정을 하지 않는다 (설계서 9.1). 분모 0 은 0% 가
  아니라 `—` 다
- **판정은 `stop` 또는 `inconclusive` 뿐이다** (R2-06). 게이트 입력(M3b·M7)이 없으면
  `미판정` — 라벨을 덜 채운 것이 "진행 허용" 이 되지 않는다. 종료 코드로도 구분한다
- 판정을 **다시 계산하지 않는다.** DB 에 남은 파이프라인의 실제 출력을 읽는다 — 우리
  알고리즘을 우리가 재구현해 비교하면 구현 두 개를 비교하는 것이다

## CI (`.github/workflows/ci.yml`)

`master` push · 모든 PR · 수동 실행. 잡 4개가 병렬로 돈다.

| 잡 | 무엇을 | 왜 별도 잡인가 |
|---|---|---|
| `verify` | 루트 typecheck · 단위 649 · DB 통합 287 | Postgres 17 서비스 컨테이너를 **55432** 로 매핑한다 (`testDb.ts` 의 기본 DSN 과 맞춰 CI 전용 환경변수를 없앴다) |
| `taimen` | taimen typecheck | taimen 은 **상위 워크스페이스에 속하지 않는다** — 루트 install 로는 UI 의존성이 깔리지 않는다 |
| `e2e` | Playwright 13건 | 브라우저 바이너리 캐시 · 루트+taimen 양쪽 install 필요 · 실패 시 trace 를 아티팩트로 올린다 |
| `restore-rehearsal` | 백업·복구 리허설 | 스키마·RLS·GRANT 를 바꾸는 PR 이 **복원 가능성**을 깨뜨리지 않았는지 매번 본다 |

> ⚠️ **`e2e` 는 네트워크가 필요하다.** MX 검증을 흉내 내지 않기 때문이다 — 승인 게이트의
> 핵심이라 가짜 리졸버로 통과시키면 검증한 것이 아니다. 잡 앞에 DNS 선행 확인 단계를 두어,
> 외부 DNS 가 막힌 러너에서 **원인을 알 수 없는 E2E 실패**가 아니라 명확한 메시지가 나오게 했다.
> 사내 러너라면 `LEADOPS_E2E_MX_DOMAIN` 으로 해석 가능한 도메인을 지정한다.

`pg_isready` 만으로 기동을 판단하지 않는다 — initdb 가 재시작하는 사이에도 ready 를 답해서
그 틈에 `create database` 가 실패한다(로컬에서 실제로 겪었다). **질의**로 확인한다.

`restore-rehearsal` 의 시드는 `--limit 20` 이다. mock 어댑터의 홈페이지 도메인은 실재하지
않아 스테이지가 도메인마다 DNS·robots 를 시도하고, 기본값 500 이면 몇 분을 쓴다. 리허설이
검증하는 것은 "행이 그대로 복원되는가" 이므로 모집단 크기는 무관하다.

## 스크립트

| 명령 | 설명 |
|---|---|
| `pnpm verify` | typecheck + 단위 + DB 테스트 |
| `pnpm e2e` | Playwright E2E 13건 (Postgres·네트워크 필요) |
| `pnpm e2e:install` | chromium 다운로드 (최초 1회) |
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
| `pnpm spike sample` | 골드셋 라벨링용 층화 표본 CSV |
| `pnpm spike measure --goldset <csv>` | **골드셋 측정** — M1~M14 + Phase 0 판정 |
| `pnpm spike <cmd>` | 스파이크 CLI (`universe` / `sample` / `measure` / `verify` / `help`) |
