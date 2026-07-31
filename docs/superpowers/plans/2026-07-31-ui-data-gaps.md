# taimen UI 데이터 공백 4건 해소 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** README "아직 없는 것"이 문서화한 화면 `—` 공백 4건(퍼널 counts · 오늘 제외 건수 · 검색 결과물 · 사이드바 사용자)을 해소한다.

**Architecture:** 파이프라인이 `runs.counts`를 스테이지 terminal 시점에 스냅샷하고, 검수 API가 `decided_at`·`search_hits`·`/api/me`를 노출하며, taimen store·mapper·Sidebar가 그것을 소비한다. 스펙: `docs/superpowers/specs/2026-07-31-ui-data-gaps-design.md`

**Tech Stack:** Node 22 · postgres.js · Next.js 16 (taimen — 독립 pnpm 워크스페이스) · vitest (`pnpm test:db` = 실제 Postgres 55432)

## Global Constraints

- **모르는 값은 0이 아니라 `—`(null).** 데이터가 없으면 화면은 기존 `—` 처리를 유지한다
- **낙관적 갱신 금지** — 서버 확인 후 반영
- 게이트웨이는 **허용 목록** — 새 경로는 `ALLOWED`에 명시해야 통과한다
- DB 마이그레이션 없음 (`runs.counts`·`review_items.decided_at` 기존재)
- 검색 결과물은 **그 검수 항목의 attempt**(`ri.attempt_id`) 기준 — "최신"이 아니다
- 관측 테이블은 `run_date` 파티션 — 테스트에서 `search_aggregates`·`search_hits` insert 시 `run_date` 필수 (fixture `createRun` 반환값 사용)
- 커밋 메시지 끝: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- DB 테스트: 루트에서 `pnpm exec vitest run --config vitest.pg.config.ts <파일>` (컨테이너 `leadops-pg` 55432 기동 중)

---

### Task 1: 검수 API — `/api/me` · 목록 `decided_at` · 상세 `search_hits`

**Files:**
- Create: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/server.ts:8-14` (import) · `:66-74` (routers 배열)
- Modify: `apps/api/src/routes/review.ts:70` (목록 select) · `:102` (상세 select) · `:120-190` (Promise.all·응답)
- Test: `apps/api/src/api.pg.test.ts`

**Interfaces:**
- Produces: `GET /api/me` → `{ data: { id, email, role } }` · 목록 행에 `decided_at: timestamptz|null` · 상세 응답에 `search_hits: Array<{ keyword, rank, channel_type, is_official, url, title, published_at, recency }>` (Task 3 의 client 타입이 이 형태에 의존)

- [ ] **Step 1: 실패하는 테스트 작성** — `api.pg.test.ts` 의 import 에 `createRun` 추가:

```typescript
import { createCandidate, createRun, createTestDb, createUser, type Candidate, type TestDb } from "@leadops/db";
```

파일 끝에 describe 블록 추가:

```typescript
describe("UI 데이터 공백 — /api/me · decided_at · search_hits", () => {
  it("GET /api/me 는 본인 프로필을 돌려준다", async () => {
    const res = await call<{ data: { id: string; email: string; role: string } }>(
      "GET", "/api/me", { token: tokenFor(userId) });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(userId);
    expect(res.body.data.email).toBe("reviewer@leadops.test");
    expect(res.body.data.role).toBe("user");
  });

  it("admin 의 role 은 admin 이다", async () => {
    const res = await call<{ data: { role: string } }>("GET", "/api/me", { token: tokenFor(adminId) });
    expect(res.body.data.role).toBe("admin");
  });

  it("제외한 항목의 목록 행에 decided_at 이 있다", async () => {
    const c = await createCandidate(db);
    const decision = await call("POST", `/api/review/${c.reviewItemId}/decision`, {
      token: tokenFor(userId),
      body: { status: "rejected", reason: "테스트 제외" },
    });
    expect(decision.status).toBe(200);
    const list = await call<{ data: Array<Record<string, unknown>> }>(
      "GET", "/api/review?status=rejected&limit=200", { token: tokenFor(userId) });
    const row = list.body.data.find((r) => r["id"] === c.reviewItemId);
    expect(row).toBeDefined();
    expect(row!["decided_at"]).toBeTruthy();
  });

  it("상세에 그 attempt 의 search_hits 가 rank 순으로 나온다 — 없으면 빈 배열", async () => {
    const run = await createRun(db);
    const c = await createCandidate(db, { runId: run.runId, attemptId: run.attemptId });
    const [agg] = await db.owner<{ id: string }[]>`
      insert into search_aggregates (
        attempt_id, company_id, run_date, keyword, keyword_kind, provider,
        total_returned, denominator, related_count, official_count, classifier_version)
      values (${run.attemptId}, ${c.companyId}, ${run.runDate}::date, '테스트 키워드', 'nonbrand',
        'naver_blog', 5, 5, 2, 1, 'v1')
      returning id
    `;
    // rank 역순으로 넣어 응답 정렬을 검증한다
    for (const rank of [2, 1]) {
      await db.owner`
        insert into search_hits (
          aggregate_id, run_date, attempt_id, company_id, keyword, rank, channel_type,
          is_official, url, url_hash, title, published_at, recency)
        values (${agg!.id}, ${run.runDate}::date, ${run.attemptId}, ${c.companyId},
          '테스트 키워드', ${rank}, 'thirdparty_blog', ${rank === 1},
          ${`https://blog.example.kr/${rank}`}, ${`h${rank}-${c.companyId}`},
          ${`글 ${rank}`}, '2026-07-01', 'd0_60')
      `;
    }
    const res = await call<{ data: { search_hits: Array<Record<string, unknown>> } }>(
      "GET", `/api/review/${c.reviewItemId}`, { token: tokenFor(userId) });
    expect(res.status).toBe(200);
    expect(res.body.data.search_hits.map((h) => h["rank"])).toEqual([1, 2]);
    expect(res.body.data.search_hits[0]!["is_official"]).toBe(true);

    const empty = await createCandidate(db);
    const res2 = await call<{ data: { search_hits: unknown[] } }>(
      "GET", `/api/review/${empty.reviewItemId}`, { token: tokenFor(userId) });
    expect(res2.body.data.search_hits).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run --config vitest.pg.config.ts apps/api/src/api.pg.test.ts`
Expected: FAIL — `/api/me` 404 · `decided_at` undefined · `search_hits` undefined

- [ ] **Step 3: `/api/me` 라우트 신설** — `apps/api/src/routes/me.ts`:

```typescript
import { badRequest, Router, type Ctx } from "../http";
import type { Session } from "../session";

/**
 * 로그인 사용자 프로필. 사이드바가 하드코딩 대신 이 값을 쓴다.
 *
 * RLS `profiles_read`(본인 또는 admin)가 본인 행 조회를 허용하므로 세션 컨텍스트
 * 그대로 질의한다 — 서버 권한으로 우회하지 않는다.
 */

export interface MeDeps {
  session: Session;
}

export function meRoutes(deps: MeDeps): Router {
  const router = new Router();

  router.get("/api/me", async (ctx: Ctx) => {
    const [row] = await deps.session.asUser(ctx.userId, (tx) => tx<
      Array<{ id: string; email: string; role: string }>
    >`
      select id, email::text as email, role::text as role
      from profiles where id = ${ctx.userId}
    `);
    // auth.users 트리거가 profiles 를 만들므로 정상 경로에서는 항상 있다.
    if (!row) throw badRequest("프로필을 찾을 수 없습니다");
    return { data: row };
  });

  return router;
}
```

`server.ts`: import 목록에 `import { meRoutes } from "./routes/me";` 추가 (알파벳 순서 — `leadRoutes` 다음), routers 배열에 `meRoutes({ session }),` 추가.

- [ ] **Step 4: 목록에 `decided_at` 추가** — `review.ts:70` 의 select 첫 줄을:

```typescript
      select ri.id, ri.rank, ri.status, ri.decided_at, c.id as company_id, c.name, c.industry,
```

- [ ] **Step 5: 상세에 `attempt_id`·`search_hits` 추가** — `review.ts:102` 상세 select 첫 줄을:

```typescript
        select ri.id, ri.rank, ri.status, ri.note, ri.attempt_id,
```

`review.ts:120` 의 구조분해와 Promise.all 에 hits 쿼리 추가 (email 쿼리 뒤):

```typescript
      const [websites, contactPages, channels, ors, competitors, email, searchHits] = await Promise.all([
```

Promise.all 배열 마지막(email 쿼리 뒤)에:

```typescript
        // ❗ 이 검수 항목을 만든 attempt 의 관측만 — "최신 attempt" 로 하면 점수와
        //    검색 결과의 출처 실행이 어긋난다. 30일 보관이 지나면 빈 배열이다.
        tx<Row[]>`
          select h.keyword, h.rank, h.channel_type, h.is_official, h.url, h.title,
                 h.published_at, h.recency
          from search_hits h
          where h.attempt_id = ${item["attempt_id"] as string} and h.company_id = ${companyId}
          order by h.keyword, h.rank
        `,
```

응답 객체(review.ts:177-188)에 `search_hits: searchHits,` 추가 (`email` 다음 줄).

- [ ] **Step 6: 통과 확인**

Run: `pnpm exec vitest run --config vitest.pg.config.ts apps/api/src/api.pg.test.ts`
Expected: PASS 전부 (기존 74 + 신규 4)

- [ ] **Step 7: 커밋**

```bash
git add apps/api/src/routes/me.ts apps/api/src/server.ts apps/api/src/routes/review.ts apps/api/src/api.pg.test.ts
git commit -m "검수 API — /api/me · 목록 decided_at · 상세 search_hits"
```

---

### Task 2: 파이프라인 — `runs.counts` 스냅샷

**Files:**
- Modify: `packages/pipeline/src/orchestrator.ts:146-216` (`advanceAttempt`)
- Test: `apps/worker/src/worker.pg.test.ts` (전체 파이프라인 테스트에 단정 추가)

**Interfaces:**
- Consumes: 없음 (독립)
- Produces: `runs.counts` jsonb 에 `raw_candidates: number`(collect terminal 시) · `analyzed: number`(score terminal 시). Task 3 의 store 가 `/api/runs` 응답의 이 키를 읽는다.

- [ ] **Step 1: 실패하는 단정 추가** — `worker.pg.test.ts` 의 전체 파이프라인 테스트
  (테스트명 `❗ 실행을 만들고 큐를 비우면 업체가 적재된다`) **끝에** 추가:

```typescript
    // ❗ 퍼널 스냅샷 (README "아직 없는 것" 해소) — collect·score terminal 시점에
    //    runs.counts 가 실측으로 채워진다. raw_candidates 는 7일 보관이라 조회 시
    //    집계로는 지난 실행이 영구 결손된다.
    const [countsRow] = await db.owner<
      Array<{ counts: { raw_candidates?: number; analyzed?: number } }>
    >`
      select counts from runs order by started_at desc nulls last limit 1
    `;
    expect(typeof countsRow!.counts.raw_candidates).toBe("number");
    expect(countsRow!.counts.raw_candidates!).toBeGreaterThan(0);
    expect(typeof countsRow!.counts.analyzed).toBe("number");
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run --config vitest.pg.config.ts apps/worker/src/worker.pg.test.ts`
Expected: 그 테스트만 FAIL — `counts.raw_candidates` 가 undefined (`{}`)

- [ ] **Step 3: `advanceAttempt` 에 스냅샷 구현** — `orchestrator.ts` 의 스테이지 루프에서
  `run_stages` update(`if (total > 0)` 블록) 안, update 문 **다음**에 추가:

```typescript
      // ❗ 퍼널 스냅샷: terminal 시점의 실측을 runs.counts 에 남긴다 (README "아직 없는 것").
      //    raw_candidates 는 7일 보관이라 조회 시 집계하면 지난 실행이 영구 결손된다.
      //    terminal 이후 재호출은 같은 값을 다시 쓸 뿐이다 (멱등).
      if (stage === "collect" && isTerminal(status)) {
        await sql`
          update runs set counts = counts || jsonb_build_object(
            'raw_candidates', (select count(*) from raw_candidates where attempt_id = ${attemptId}))
          where id = (select run_id from run_attempts where id = ${attemptId})
        `;
      }
      if (stage === "score" && isTerminal(status)) {
        await sql`
          update runs set counts = counts || jsonb_build_object(
            'analyzed', (select count(*) from scores where attempt_id = ${attemptId}))
          where id = (select run_id from run_attempts where id = ${attemptId})
        `;
      }
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run --config vitest.pg.config.ts apps/worker/src/worker.pg.test.ts`
Expected: PASS 전부 (18 + 단정 강화 1)

- [ ] **Step 5: 커밋**

```bash
git add packages/pipeline/src/orchestrator.ts apps/worker/src/worker.pg.test.ts
git commit -m "advanceAttempt 가 runs.counts 를 스냅샷 — collect·score terminal 시점"
```

---

### Task 3: taimen — 게이트웨이·client·store·Sidebar·드로어 연결

**Files:**
- Modify: `taimen/src/app/api/gateway/[...path]/route.ts:20-46` (ALLOWED)
- Modify: `taimen/src/lib/data/client.ts` (타입 3곳 + `api.me`)
- Modify: `taimen/src/lib/data/types.ts:129-134` (SearchAsset) · `:340-352` (TodayMetrics 주석)
- Modify: `taimen/src/lib/data/mapper.ts` (mapDetail 의 `searchAssets`)
- Modify: `taimen/src/lib/data/store.tsx:45-57` (OpsSnapshot) · `:212-243` (loadOps) · `:424-457` (metrics)
- Modify: `taimen/src/components/shell/Sidebar.tsx:99-108` (사용자 블록)

**Interfaces:**
- Consumes: Task 1 의 `/api/me`·`decided_at`·`search_hits`, Task 2 의 `runs.counts` 키
- Produces: 없음 (말단)

- [ ] **Step 1: 게이트웨이 허용** — `route.ts` ALLOWED 배열 맨 앞(`api/review` 앞)에:

```typescript
  { method: "GET", pattern: ["api", "me"] },
```

- [ ] **Step 2: client.ts 갱신**

`ApiReviewRow` 에 필드 추가 (`status: string;` 다음):

```typescript
  decided_at: string | null;
```

`ApiReviewDetail` 에 필드 추가 (`nonce: string | null;` 앞):

```typescript
  search_hits: Array<{
    keyword: string;
    rank: number;
    channel_type: string;
    is_official: boolean;
    url: string;
    title: string | null;
    published_at: string | null;
    recency: string;
  }>;
```

`ApiRunRow` 의 doc 주석에서 counts 관련 ❗ 두 줄을 다음으로 교체 (네이버 쿼터 줄은 유지):

```typescript
 * ❗ `counts` 는 파이프라인이 collect·score 스테이지 terminal 시점에 채운다
 *    (`raw_candidates`·`analyzed`). 그 이전(구버전) 실행은 빈 객체다 — 소급하지 않는다.
```

새 타입·엔드포인트 추가 (`ApiCosts` 뒤, `api` 객체 앞):

```typescript
export interface ApiMe {
  id: string;
  email: string;
  role: string;
}
```

`api` 객체에 (reviewList 앞):

```typescript
  me: () => request<ApiMe>("GET", "api/me"),
```

- [ ] **Step 3: types.ts 갱신** — `SearchAsset` 을:

```typescript
export interface SearchAsset {
  /** DB `channel_type` 어휘 그대로 (표시 전용 — 변환 계층을 두지 않는다). */
  channel: string;
  title: string;
  /** 발행일 (YYYY-MM-DD). 발행일을 모르면 빈 문자열 — 수집일로 대체하지 않는다. */
  date: string;
  official: boolean;
}
```

`TodayMetrics` 의 doc 주석에서 `rawCandidates`·`analyzed`·`rejected` 항목을 다음으로 교체
(`costKrw`·`naverQuotaPct` 항목은 유지):

```typescript
 *  - `rawCandidates`·`analyzed` — 오늘 run 의 `runs.counts` 스냅샷. 오늘 실행이 없거나
 *    구버전 실행(빈 counts)이면 `null` 이다.
 *  - `rejected` — `/api/review?status=rejected` 목록의 `decided_at` 오늘(KST)분.
 *    목록 limit(200)를 넘는 날은 하한값이다 — 일 상한 50 체제에서 현실적으로 없다.
```

- [ ] **Step 4: mapper.ts** — `mapDetail` 의 `searchAssets: [],` 를 다음으로 교체:

```typescript
    searchAssets: payload.search_hits.map((h) => ({
      channel: h.channel_type,
      // 제목이 없으면 URL 을 보여 준다 — 링크가 무엇인지는 알려야 한다.
      title: h.title ?? h.url,
      date: h.published_at ?? "",
      official: h.is_official,
    })),
```

`mapListItem` 의 `searchAssets: []` 는 그대로 둔다 (목록에는 hits 가 없다).

- [ ] **Step 5: store.tsx** — `OpsSnapshot` 에 필드 추가 (`costsForbidden` 앞):

```typescript
  /** 오늘 run 의 `counts` 스냅샷. 오늘 실행이 없으면 `null`. */
  todayRawCandidates: number | null;
  todayAnalyzed: number | null;
  /** `decided_at` 이 오늘(KST)인 제외 건수. 목록 limit 초과 시 하한값. */
  rejectedToday: number | null;
```

`emptyOps` 에 `todayRawCandidates: null, todayAnalyzed: null, rejectedToday: null,` 추가.

`loadOps` 의 Promise.all 을 4원소로 확장하고 계산 추가:

```typescript
  const [settings, runs, costs, rejectedRows] = await Promise.all([
    api.settings().then((r) => r.data).catch(() => null),
    api.runs(1).then((r) => r.data).catch(() => null),
    api
      .costs()
      .then((r) => ({ data: r.data, forbidden: false }))
      .catch((err) => ({ data: null, forbidden: err instanceof ApiError && err.status === 403 })),
    api.reviewList("rejected").then((r) => r.data).catch(() => null),
  ]);
```

return 앞에 계산, return 에 필드 추가:

```typescript
  const today = seoulToday();
  const seoulDate = (iso: string): string =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(iso));
  // ❗ 오늘 run 의 counts 만 퍼널에 쓴다. 어제 실행의 수집량을 오늘 것처럼 보여 주지 않는다.
  const todayCounts = latest?.run_date === today ? latest.counts : {};
```

```typescript
    todayRawCandidates: finiteNumber(todayCounts["raw_candidates"]),
    todayAnalyzed: finiteNumber(todayCounts["analyzed"]),
    rejectedToday:
      rejectedRows === null
        ? null
        : rejectedRows.filter((r) => r.decided_at !== null && seoulDate(r.decided_at) === today).length,
```

`metrics` useMemo 의 실데이터 return 에서 세 줄 교체 (⚠️ 주석 두 개는 삭제):

```typescript
      rawCandidates: state.ops.todayRawCandidates,
      analyzed: state.ops.todayAnalyzed,
      rejected: state.ops.rejectedToday,
```

- [ ] **Step 6: Sidebar.tsx** — 상단 import 를:

```typescript
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type ApiMe } from "@/lib/data/client";
```

`Sidebar()` 함수 안(pathname 다음)에:

```typescript
  // ❗ 하드코딩하지 않는다. 실패·로딩 중에는 가짜 이름 대신 `—` 를 보여 준다.
  const [me, setMe] = useState<ApiMe | null>(null);
  useEffect(() => {
    api.me().then((r) => setMe(r.data)).catch(() => setMe(null));
  }, []);
  const roleLabel = me === null ? "—" : me.role === "admin" ? "Admin" : me.role === "user" ? "Reviewer" : me.role;
```

사용자 블록(99-108행)을:

```tsx
      {/* 사용자 — /api/me. fixture 모드·인증 실패 시 — 표시 */}
      <div className="flex items-center gap-3 border-t border-line px-5 py-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface text-xs font-semibold text-fg-3">
          {me?.email?.[0]?.toUpperCase() ?? "—"}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-fg-3">{me?.email ?? "—"}</span>
          <span className="mono-label text-[8px]">{roleLabel}</span>
        </div>
      </div>
```

- [ ] **Step 7: typecheck 확인**

Run: `cd taimen && pnpm typecheck` (또는 taimen 디렉터리에서 `pnpm typecheck`)
Expected: PASS. 루트도: `pnpm typecheck` PASS

- [ ] **Step 8: 커밋**

```bash
git add taimen/src/app/api/gateway taimen/src/lib/data taimen/src/components/shell/Sidebar.tsx
git commit -m "taimen — 퍼널 counts·오늘 제외·검색 결과물·/api/me 연결 (— 4칸 해소)"
```

---

### Task 4: 전체 검증 + README 갱신

**Files:**
- Modify: `README.md` ("아직 없는 것" 절의 `—` 표)

**Interfaces:**
- Consumes: Task 1~3 전부

- [ ] **Step 1: 전체 게이트**

Run: `pnpm verify` → PASS (typecheck · 단위 · DB 통합)
Run: `pnpm e2e` → PASS 13건 (⚠️ taimen dev 서버가 꺼져 있어야 한다 — 현재 꺼져 있음.
Postgres 컨테이너·외부 DNS 필요)

- [ ] **Step 2: README 갱신** — "아직 없는 것" 절의 `**API 가 줄 수 없어서 화면이 …**` 표에서
  해소된 4행(퍼널 상단 · 오늘 제외 건수 · 검색 결과물 목록 · 사이드바 사용자·역할)을 제거하고
  실행별 네이버 쿼터 행만 남긴다. 표 위 문장은 유지하되 "5건 중 4건은 해소됐다"는 식의
  이력 서술은 넣지 않는다 — 표는 현재 상태만 말한다.

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "README — 화면 — 공백 표에서 해소 4건 제거"
```

---

## Self-Review 결과

- **스펙 커버리지**: §1 counts 스냅샷(Task 2 — 병합 `||`·terminal 시·소급 없음·오늘 run 판정은 Task 3 store) · §2 decided_at(Task 1 API + Task 3 store, limit 하한 주석 포함) · §3 search_hits(Task 1 — `ri.attempt_id` 기준·rank 순·빈 배열, Task 3 mapper — 제목 없으면 URL) · §4 /api/me(Task 1 + 게이트웨이 + Sidebar `—` 폴백) · 테스트(§테스트 — api 4건·worker 단정·typecheck·e2e). 완료 기준의 "로컬 dev 확인"은 dev 서비스가 현재 꺼져 있어 계획에서 제외 — e2e 가 화면 경로를 덮는다.
- **플레이스홀더**: 없음 — 전 코드 블록 전문 수록.
- **타입 일관성**: `ApiMe`(client)·`api.me()`·Sidebar import 일치. `search_hits` 응답 필드 = client 타입 = mapper 소비 필드 일치. `OpsSnapshot` 3필드 = emptyOps = loadOps return = metrics 소비 일치. `SearchAsset.channel: string` = mapper `h.channel_type` 일치 (fixtures 의 리터럴은 string 에 포함되므로 무변경).
