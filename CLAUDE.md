# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 저장소 개요

LeadOps — 마케팅 에이전시 내부용 아웃바운드 리드 발굴 도구. 공공 데이터(HIRA·공정위)로
모집단을 모으고, 홈페이지·채널·검색 점유를 분석해 영업 가치가 높은 리드만 선별한다.

문서·코드 주석·커밋 메시지는 전부 **한국어**다. `README.md` 가 설계·검증 상태의 단일
소스이고, `docs/00-plan.md`(설계서 v3)·`docs/07-runbook.md`(운영 런북)가 뒤를 받친다.
무언가를 바꾸기 전에 README 의 해당 절부터 확인할 것 — 대부분의 설계 결정에 이유가 적혀 있다.

## 명령어

pnpm 모노레포 (Node ≥22, `pnpm@10`). 루트에서 `pnpm install` 후:

```bash
pnpm typecheck            # TypeScript strict 검사 (pnpm build 도 typecheck 만 한다 — 번들 없음)
pnpm test                 # 단위·통합 테스트 (DB 불필요)
pnpm db:up                # 테스트용 Postgres 17 컨테이너 (Docker, 포트 55432)
pnpm test:db              # DB 통합 테스트 — 실제 Postgres 필요 (*.pg.test.ts)
pnpm verify               # typecheck + test + test:db (전체 검증)
pnpm e2e:install          # Playwright chromium (최초 1회)
pnpm e2e                  # E2E 13건 — Postgres·실제 네트워크(DNS·MX) 필요
```

단일 테스트 실행 — vitest 파일 필터를 그대로 쓴다:

```bash
pnpm test packages/http/src/ssrf.test.ts             # 단위 테스트 한 파일
pnpm test -- -t "테스트 이름"                         # 이름으로 필터
pnpm test:db packages/db/src/rls.pg.test.ts          # DB 테스트 한 파일 (db:up 선행)
```

앱 실행:

```bash
DATABASE_URL=postgres://postgres:leadops@127.0.0.1:55432/leadops pnpm db:migrate --bootstrap
pnpm worker run --industry=derm,dental    # 실행 하나를 만들고 끝까지 처리
pnpm api                                  # 검수 API (API_DATABASE_URL·SUPABASE_JWT_SECRET 필요)
pnpm spike universe|sample|measure|verify # Phase 0 스파이크 CLI (DB 없이 동작)
```

전체 로컬 기동 순서(계정 생성·워커 역할 password 포함)는 README "UI 연동" 절 참조.

### taimen (검수 콘솔 UI)

- **루트 워크스페이스에 속하지 않는다.** `taimen/pnpm-workspace.yaml` 이 경계다.
  루트 `pnpm install` 로는 UI 의존성이 깔리지 않으므로 `taimen/` 안에서 따로 설치한다.
- Next 16 · React 19 · Tailwind 4 · **TypeScript 6** (루트는 5.9 — 버전이 다르다).
- `taimen/` 안에서: `pnpm dev` · `pnpm typecheck`.
- 개발 접속은 `127.0.0.1:3000` 이 아니라 **`localhost:3000`** — Next 16 이 HMR 을
  cross-origin 으로 막는다.
- E2E 실행 중에는 taimen 의 `next dev` 를 꺼야 한다 — Next 는 디렉터리 단위로 두 번째
  dev 인스턴스를 거부한다(포트가 달라도).

## 테스트 배치 규칙

- `*.test.ts` — 기본 스위트(`vitest.config.ts`). DB 불필요.
- `*.pg.test.ts` — 실제 Postgres 필요(`vitest.pg.config.ts`). RLS·plpgsql·행 잠금·복합 FK 는
  흉내 낼 수 없으므로 **모킹하지 않는다.** 파일마다 자기 데이터베이스를 만들고, 파일 내부는
  순차 실행이다(동시 승인 테스트가 시계에 민감).
- MX·DNS 검증도 흉내 내지 않는다 — E2E 가 네트워크를 요구하는 이유다
  (도메인은 `LEADOPS_E2E_MX_DOMAIN` 으로 교체 가능).

## 아키텍처

### 워크스페이스 구성

```
packages/core       도메인 타입 · Zod 환경변수 검증 · 에러 · PII 마스킹(redact) · 소스 레지스트리 · 로거
packages/http       SSRF 방어 · robots.txt 게이트 · rate limit · 백오프 · HttpClient · MX 검증
packages/adapters   SourceAdapter·SearchAdapter 계약 · HIRA · 공정위 · 네이버 검색 · RSS/Atom · Mock · 팩토리
packages/db         마이그레이션(0000~) · RLS · RPC 15종 · 테스트 하네스(testDb.ts·fixtures.ts)
packages/pipeline   12개 스테이지 + 오케스트레이터(DAG) · 점수·게이트·추천
apps/api            검수 API — JWT 검증(HS256 dev + ES256 Supabase) · RLS 세션 · MX 게이트 · HMAC 내부 트리거
apps/worker         잡 루프 — fencing token · heartbeat · 안전 종료 · schedule/capacity/cleanup/reap CLI
apps/spike          Phase 0 스파이크 CLI · 골드셋 측정 하네스
apps/e2e            Playwright E2E
taimen/             검수 콘솔 (Next.js · 독립 워크스페이스)
```

`vitest.config.ts` 의 alias 가 `@leadops/*` 를 각 패키지의 `src/index.ts` 로 직결한다 —
테스트는 빌드 산출물이 아니라 소스를 본다. 새 패키지를 추가하면 alias 도 추가해야 한다.

### 파이프라인 (packages/pipeline)

```
collect → normalize → exclude_basic → homepage_discover → homepage_detect
  → contact_pages · channel_analyze · search_analyze (병렬)
  → competitor_analyze → score → recommend · shortlist
```

- 각 스테이지는 **멱등**하다. 잡 큐에 의존 관계 개념이 없으므로 `orchestrator.ts` 가 선행
  스테이지 terminal 시 다음을 enqueue 한다(DAG).
- `homepage_discover`(후보 발견)와 `homepage_detect`(공식 판정)의 순서가 핵심이다 —
  뒤바뀌면 "검색이 찾았으니 공식"이 된다. 발견은 후보만 만들고, 판정은 다신호 합산이 한다.
- 재평가는 주기가 아니라 **변경**(`content_fingerprint` 비교)이 촉발한다.

### 강제는 DB 안에 있다

승인 상한·업종 쿼터·게이트·nonce·rate limit 은 전부 DB(RLS·RPC·CHECK·행 잠금)에 있다.
**API 는 입력과 결과를 옮길 뿐이고, UI 는 보여 줄 뿐이다.** API 를 우회해도 규칙이 유지된다.

- `authenticated` 는 어떤 테이블에도 직접 쓸 수 없다 (정책·GRANT 두 겹).
- MX 검증 기록(`verify_contact_email`)은 `service_role` 전용 — 검수자가 스스로 게이트를
  통과시킬 수 없다.
- 워커는 `jobs` UPDATE 권한이 없고 fencing token 으로만 완료를 기록한다 — 좀비 워커의
  늦은 쓰기가 무시된다.
- 상한은 `runs.settings_snapshot` 에서 읽힌다 — live `settings` 만 바꾸면 진행 중 실행의
  판정은 바뀌지 않는다 (의도된 설계).

### 마이그레이션 (packages/db/migrations)

- 번호 순 단방향 체인. 새 변경은 새 번호 파일로 추가한다.
- `0000_local_bootstrap` 은 **로컬 전용** — Supabase 에는 `--bootstrap` 없이 적용한다
  (auth 스키마·역할은 Supabase 가 제공).
- `deploy/` 는 체인에 없다 — pg_cron·pg_net 이 있는 배포 대상에만 손으로 적용.
- `settings` 는 키 하나에 그 키의 객체만 담는다(`key='review'`, `value={...}`) —
  함수에서 `value #>> '{review,...}'` 처럼 키를 한 번 더 타면 항상 NULL 이 되어 설정이
  조용히 무시된다(0013 이 고친 결함). 설정을 읽는 코드는 "바꾼 값이 실제로 동작을 바꾼다"
  를 테스트해야 한다.

### 기능 플래그 — 축소 파이프라인이 1급 경로

- `FEATURE_SOURCE`: `mock`(기본) / `live`. `NODE_ENV=production` 에서 mock 은 부팅 실패.
- `FEATURE_ORS`: `off`(기본) / `shadow`(산출·기록만, 배점 0) / `on`(배점 25). `off` 면
  어댑터가 아예 로드되지 않고 `search_analyze` 는 실패가 아니라 **건너뛴다**.
- `FEATURE_LLM`: `off` 로 전체가 동작해야 한다. LLM 은 추천 문장 정리에만 쓰고 선정은 규칙이 한다.
- 환경변수는 부팅 시 Zod 로 검증한다. 키가 없으면 mock 으로 조용히 폴백하지 않고
  **부팅에 실패한다.**

## 이 저장소의 불변 규칙

README "이 코드가 강제하는 규칙" 표(약 60건)가 전체 목록이다. 전부 **테스트가 깨지도록**
만들어져 있으므로, 아래를 우회하는 코드는 테스트 실패로 드러난다. 작업 시 가장 자주
부딪히는 것들:

- **홈페이지에서 이메일을 자동 추출하지 않는다** (정보통신망법 제50조의2).
  `packages/core/src/policy.test.ts` 가 소스 전체를 스캔해 이메일 추출 정규식이 생기면
  실패한다. 연락처 페이지는 링크 URL·앵커 텍스트만 보고 본문을 fetch 하지 않는다.
- **PII(이메일·전화·주민번호)는 로그·LLM 프롬프트로 나가지 않는다** — 로거가 출력 직전
  `redact` 를 강제 호출한다.
- **fail-closed.** robots 조회 실패·포털 응답 손상·인증 미구성은 "0건"이나 폴백이 아니라
  에러다. 설정이 없거나 범위 밖이면 `configuration_error`.
- **측정하지 못한 값은 0 이 아니라 `null`/`unavailable`** — 만점에서 빼고 재정규화하지
  않는다. UI 도 `—` 로 표시하고 0 으로 채우지 않는다. ORS 분모 0 은 0 이 아니라 null.
- **쿼터는 호출 전에 선점한다** (`cost_ledger.entry_key` unique + advisory lock) —
  재시도가 이중 계상되지 않고, 과소 계상(계정 차단)보다 과다 계상 쪽으로 틀린다.
- **UI 는 낙관적 갱신을 하지 않는다** — 승인은 409/422/403 으로 거절될 수 있고, 서버 확인
  후 목록을 다시 읽는다.
- **토큰은 브라우저에 내려가지 않는다** — taimen 은 `/api/gateway` 프록시(허용 목록)를
  통해서만 API 를 부르고, 토큰은 `src/lib/server/token.ts` 에만 있다.
- **어댑터의 `verifiedAgainstLiveApi` 는 실 API 응답으로 확인하기 전에는 true 로 바꾸지
  않는다.** 가짜 응답으로 "완료" 처리하지 않는 것이 이 저장소의 원칙이다 — 검증 절차는
  `docs/06-adapter-verification.md`, fixture 는 `fixtures/http/`.
- **일괄 승인 경로를 만들지 않는다** — `bulk-decision` 은 제외만 한다.

## 검증 상태 표기 관행

README·docs 는 "구현됨"과 "검증됨"을 구분한다 — 실측하지 않은 지표는 `미측정`, 판정 불가는
`미판정` 으로 적고 숫자를 만들지 않는다. 문서를 갱신할 때 이 구분을 유지할 것.
