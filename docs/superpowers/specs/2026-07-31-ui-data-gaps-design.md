# taimen UI 데이터 공백 4건 해소 — 설계

2026-07-31 · README "아직 없는 것" 절이 문서화한 "API 가 줄 수 없어서 화면이 `—` 로 두는
값들" 중 4건을 해소한다. 5번째(실행별 네이버 쿼터)는 **보류** — ORS 가 off 라 데이터가
없고 `cost_ledger` 구조 확장이 필요해 네이버 자격증명 확보 후가 적기다 (발주자 결정).

## 원칙 (기존 규칙 유지)

- **모르는 값은 0 이 아니라 `—`.** 이 작업은 "모름"을 "앎"으로 바꾸는 것이지, 표시를
  꾸미는 것이 아니다. 데이터가 없으면 화면은 지금처럼 `—` 를 유지한다.
- **낙관적 갱신 금지** · 게이트웨이 허용 목록 유지 · DB 마이그레이션 불필요
  (`runs.counts`·`review_items.decided_at` 컬럼은 이미 있다).

## 1. 퍼널 상단 — `runs.counts` 스냅샷

`runs.counts` 는 선언만 되고 파이프라인이 쓰지 않아 항상 `{}` 다. **스냅샷 방식**으로
채운다: `advanceAttempt`(packages/pipeline/src/orchestrator.ts)가 스테이지를 terminal 로
마감하는 시점에 실측 집계를 `runs.counts` 에 병합한다.

| 스테이지 terminal | counts 키 | 값 |
|---|---|---|
| `collect` | `raw_candidates` | 그 attempt 의 `raw_candidates` 건수 |
| `score` | `analyzed` | 그 attempt 의 `scores` 행 수 |

- 병합은 `counts = counts || jsonb_build_object(...)` — 다른 키를 지우지 않는다.
- terminal 전이 시점에만 1회 계산한다 (`advanceAttempt` 는 멱등하므로 이미 키가 있으면
  다시 쓰지 않아도 되고, 다시 써도 같은 값이다 — 단순성을 위해 전이 시 항상 갱신).
- **조회 시 집계 대안은 기각**: `raw_candidates` 는 7일 보관이라 지난 실행의 퍼널이
  영구 결손되고, 조회마다 count 비용이 든다. 스냅샷은 보존기간과 무관하다.
- **과거 실행은 소급하지 않는다.** 빈 counts = `—` 가 정직한 표시다.
- UI: store 가 오늘 run 의 `counts.raw_candidates`·`counts.analyzed` 를 읽는다.
  키가 없으면 지금처럼 `null` → `—`.

## 2. 오늘 제외 건수 — `decided_at` 노출

`/api/review` 목록 select 에 `ri.decided_at` 을 추가한다. store 는 `status=rejected`
목록에서 `decided_at` 이 오늘(KST)인 것만 세어 `metrics.rejected` 를 채운다.

- **알려진 한계 (수용)**: 목록 `limit` 를 넘는 날은 하한값이 된다. 일 승인 상한 50
  체제에서 하루 제외가 limit(기본 페이지 상한)를 넘는 일은 현실적으로 없다. UI 는
  집계가 아니라 목록 기반이므로 이 한계를 코드 주석으로 남긴다.
- KST 판정은 기존 store 의 오늘 계산(`approvedToday` 방식)과 동일한 방식을 쓴다 —
  두 갈래로 만들지 않는다.

## 3. 검색 결과물 — 상세 응답에 `search_hits`

`/api/review/:id` 상세의 `Promise.all` 에 hits 쿼리를 추가한다.

- 대상: **그 검수 항목의 attempt**(`ri.attempt_id`) 기준, `rank` 순 — 드로어는 이 후보를
  만든 실행의 관측을 보여줘야 한다. "최신 attempt" 로 하면 점수와 검색 결과의 출처가
  어긋날 수 있다.
- 필드: `url, title, channel_type, rank, is_official, published_at, recency, keyword`.
- `search_hits` 에는 `is_related = true` 인 문서만 저장돼 있고 30일 보관이다 —
  보관 만료·ORS off 실행이면 빈 배열이고, 드로어 SignalStream 은 기존 빈 상태
  처리를 유지한다.
- 본문은 애초에 저장하지 않으므로 (피드·검색 정책) 노출할 본문도 없다 — URL·제목·
  메타데이터만 나간다.

## 4. 사이드바 사용자 — `GET /api/me`

- 신규 라우트 `GET /api/me`: JWT 의 userId 로 `profiles` 에서 `id, email, role` 반환.
  RLS `profiles_read` 정책(본인 또는 admin)이 본인 행 조회를 허용하므로 세션 컨텍스트
  그대로 질의한다.
- 게이트웨이 `ALLOWED` 에 `{ method: "GET", pattern: ["api", "me"] }` 추가.
- Sidebar 하드코딩(`seokcess@glitzy.kr` / `Reviewer`)을 이 값으로 대체한다.
  로딩 중·실패 시 `—` 표시 — 가짜 이름을 넣지 않는다. role 표기는 DB 값
  (`admin`/`user`)을 화면 어휘(`Admin`/`Reviewer`)로 매핑하되 알 수 없는 값은
  그대로 노출한다 (변환 계층 최소화).

## 테스트

- `api.pg.test.ts`: `/api/me` 본인 프로필 반환 · 목록에 `decided_at` 존재 ·
  상세에 `search_hits` 배열 존재(있는 경우 rank 순, 없는 경우 빈 배열)
- 파이프라인 pg 테스트: mock 실행 후 `runs.counts` 에 `raw_candidates`·`analyzed`
  키가 있고 실측과 일치
- 게이트웨이: taimen typecheck + 기존 E2E 회귀 (`pnpm e2e`)

## 완료 기준

- `pnpm verify` + `pnpm e2e` 전부 통과
- 로컬 dev 환경에서 `/today` 퍼널 6칸 중 `—` 가 4칸 → 0칸 (오늘 실행이 있을 때),
  사이드바에 실제 로그인 사용자·역할 표시
