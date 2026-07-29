# LeadOps — Outbound Lead Finder

마케팅 에이전시 내부용 리드 발굴 도구. 검색 수요는 있으나 검색 결과물·콘텐츠 점유가
경쟁사보다 부족한 업체를 찾아 영업 가치가 높은 리드만 선별한다.

> **현재 상태: Phase 3 완료 (홈페이지 판별·연락처 페이지 후보)**
> 설계서 `docs/00-plan.md` v3 기준. 검색 분석부터는 아직 없다.

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
pnpm verify               # typecheck + 398 단위 + 139 DB 테스트

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
packages/adapters   SourceAdapter 계약 · HIRA · 공정위 · Mock · 팩토리
packages/db         마이그레이션 · RLS · RPC · 테스트 하네스
packages/pipeline   정규화 · 중복 제거 · 제외 규칙 · HTML 스캐너 · 도메인 분류 ·
                    공식 홈페이지 판정 · 연락처 페이지 탐지 · 스테이지 · 오케스트레이션
apps/worker         잡 루프 (fencing · heartbeat · 안전 종료)
apps/spike          Phase 0 스파이크 CLI (DB 없이 동작)
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
| `NODE_ENV=production` 에서 mock 어댑터는 부팅을 막는다 | 같은 파일 |
| ORS(네이버)는 자격증명 없이 켤 수 없다 | 같은 파일 |
| 승인되지 않은 데이터 소스는 어댑터가 실행을 거부한다 | `packages/core/src/sourceRegistry.ts` |

## ⚠️ 검증 상태

**실 API 응답으로 검증되지 않은 부분이 있다.** 가짜 응답으로 "완료" 처리하지 않기 위해
어댑터마다 `verifiedAgainstLiveApi` 플래그를 두었고, CLI 가 실행할 때마다 경고한다.

| 어댑터 | 상태 | 남은 일 |
|---|---|---|
| `MockSourceAdapter` | 해당 없음 | — |
| `HiraHospitalAdapter` | **부분 검증** | 경로는 401 응답으로 확인됨. 필드명·진료과목 코드값은 실키 필요 |
| `FtcFranchiseAdapter` | **미검증** | 후보 경로 전부 500. 가이드 문서의 요청주소 필요 |

`pnpm spike verify` 가 엔드포인트 후보를 탐색하고, 코드값을 경험적으로 검사하고,
실제 응답을 fixture 로 녹화한다. 절차는 [docs/06-adapter-verification.md](docs/06-adapter-verification.md).

## 파이프라인 (Phase 3 완료 구간)

```
collect          어댑터 → raw_candidates       (업종당 잡 1개)
  ↓
normalize        raw → companies + 관측 이력    (중복 제거 · 변경 탐지)
  ↓
exclude_basic    폐업·휴업·대형·가맹100+ 제외
  ↓
homepage_detect  홈페이지 1회 fetch → 공식 판정 + 연락처 페이지 후보
  ↓
contact_pages    게이트 강제 · 공유 본문 강등 · 커버리지 집계 (네트워크 요청 없음)
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

## 아직 없는 것

검색 분석(ORS) · 채널 분석 · 경쟁사 선정 · 점수 계산 · 추천 · 검수 API · 대시보드.

다음은 Phase 4(검색·채널 분석)다. 다만 ORS 는 설계서 결론 C 에 따라 **네이버 서면 승인 전까지
배점 0(shadow)** 이므로, 채널 분석(RSS·유튜브)부터 시작하는 편이 실익이 크다.

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
