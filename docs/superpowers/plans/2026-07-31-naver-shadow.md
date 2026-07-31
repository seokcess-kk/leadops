# 네이버 검색 API shadow 가동 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** D-002 재확인 기록을 정합시키고, `verifyNaver` 검증 하네스로 실응답을 녹화한 뒤, `FEATURE_ORS=shadow` 로 전환한다 (M1·M6 전체 실측은 계획 밖 — 컨트롤러가 백그라운드 장기 실행으로 수행).

**Architecture:** 기록(문서·코드 레지스트리·DB 0016) → 검증(verify.ts 확장, 실키 녹화, fixture 회귀) → 전환(.env shadow + 소량 live 스모크). 스펙: `docs/superpowers/specs/2026-07-31-naver-shadow-design.md`. 약관 스냅샷은 `docs/legal/naver-terms-2026-07-31.md` 에 스테이징돼 있다.

**Tech Stack:** TypeScript strict · vitest · 실 Postgres (55432) · 네이버 오픈 API legacy (`openapi.naver.com/v1/search`)

## Global Constraints

- **자격증명 없으면 skip, fail 아님** — 검색 어댑터는 선택적, 축소 파이프라인이 1급 경로
- fixture 는 회귀에 필요한 최소만 (`FIXTURE_ITEMS` 상한 — verify.ts 기존 상수 재사용)
- `verifiedAgainstLiveApi = true` 는 **실검증 성공 후에만** 전환한다
- 부팅 게이트는 코드 레지스트리(`assertSourceApproved`) — DB `source_registry` 는 감사 기록이며 코드와 정합해야 한다
- 이미 적용된 마이그레이션(0006)은 고치지 않는다 — DB 갱신은 새 마이그레이션 `0016_naver_approval.sql`
- legacy 기한 **2027-06-30** 을 기록에 남긴다 (sourceRegistry note · D-002 추기)
- `.env` 는 커밋 대상이 아니다
- 커밋 메시지 끝: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- DB 테스트: `pnpm exec vitest run --config vitest.pg.config.ts <파일>` (컨테이너 `leadops-pg` 55432)

---

### Task 1: 기록 정합 — D-002 추기 · sourceRegistry · 마이그레이션 0016

**Files:**
- Modify: `docs/03-decisions.md:44-47` (D-002 "남는 리스크" 절 아래 추기)
- Modify: `packages/core/src/sourceRegistry.ts:60-74` (naver_search 항목)
- Create: `packages/db/migrations/0016_naver_approval.sql`
- Test: `packages/db/src/schema.pg.test.ts:24-41` (마이그레이션 목록) + 신규 단정

**Interfaces:**
- Produces: DB `source_registry` naver 행 `approved=true`. 코드 레지스트리 note 에 2027-06-30 기한.

- [ ] **Step 1: 실패하는 테스트** — `schema.pg.test.ts` 마이그레이션 목록(24-41행)에 `"0016_naver_approval.sql",` 추가 (0015 다음). 같은 describe 에 테스트 추가:

```typescript
  it("0016: 네이버 승인이 코드 레지스트리와 정합한다 (D-002 재확인 2026-07-31)", async () => {
    const [row] = await db.owner<Array<{ approved: boolean; reviewed_at: string; note: string }>>`
      select approved, reviewed_at::text as reviewed_at, note
      from source_registry where source = 'naver_search'
    `;
    expect(row!.approved).toBe(true);
    expect(row!.reviewed_at).toBe("2026-07-31");
    expect(row!.note).toContain("2027-06-30");
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run --config vitest.pg.config.ts packages/db/src/schema.pg.test.ts`
Expected: FAIL — 목록에 0016 없음(파일 부재) 및 naver `approved=false`

- [ ] **Step 3: 마이그레이션 작성** — `packages/db/migrations/0016_naver_approval.sql`:

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- D-002 재확인 (2026-07-31) — 네이버 검색 오픈 API 승인을 코드 레지스트리와 정합시킨다.
--
-- 부팅 게이트는 코드(packages/core/src/sourceRegistry.ts · assertSourceApproved)다.
-- 이 테이블은 감사 기록·운영 폴백 스위치이므로 코드와 어긋나면 안 된다.
-- 0006 시드는 "약관 문언 미검증" 상태의 approved=false 였다 — 전문 확인이 끝났으므로 올린다.
-- 서면 근거: docs/legal/naver-terms-2026-07-31.md (약관 전문 스냅샷 · 발주자 재확인)
-- ─────────────────────────────────────────────────────────────────────────────

update source_registry
set approved = true,
    reviewed_by = '발주자',
    reviewed_at = '2026-07-31',
    note = '약관 전문 확인 완료 (docs/legal/naver-terms-2026-07-31.md · 7.3③/특약2.1/8조). '
           'legacy 엔드포인트는 기존 이용자 지위로 2027-06-30 까지 — 그 전에 API HUB(variant: apihub) 이관 필요. '
           '문제 발생 시 approved=false 로 되돌리면 축소 파이프라인으로 폴백된다.'
where source = 'naver_search';
```

- [ ] **Step 4: sourceRegistry.ts 갱신** — naver_search 항목(60-74행)을:

```typescript
  naver_search: {
    source: "naver_search",
    label: "네이버 검색 오픈 API",
    termsUrl: "https://developers.naver.com/products/terms/",
    legalBasis: "네이버 API 이용약관",
    allowedUse: "사내 리드 발굴 분석 (결과 원문 재배포 금지)",
    redistributionAllowed: false,
    // D-002 (docs/03-decisions.md) — 발주자 승인. 2026-07-31 약관 전문 재확인 완료
    // (docs/legal/naver-terms-2026-07-31.md · 7.3③ 저장·가공 제한, 특약 2.1, 8조).
    // ❗ legacy 엔드포인트는 기존 이용자 지위로 **2027-06-30 까지** — 그 전에
    //    API HUB(variant: "apihub") 이관 필요 (약관 부칙, 2026-07-31 시행).
    //    문제가 생기면 이 한 행을 approved:false 로 바꾸면 즉시 축소 파이프라인으로 폴백된다.
    approved: true,
    writtenApprovalRef: "D-002",
    reviewedBy: "발주자",
    reviewedAt: "2026-07-31",
    note: "약관 전문 확인 완료. legacy 기한 2027-06-30 — API HUB 이관 필요.",
  },
```

- [ ] **Step 5: D-002 추기** — `docs/03-decisions.md` 의 D-002 "남는 리스크 (기록)" 절 마지막 줄
  (`- 네이버가 이용을 제한할 경우 …`) 다음, `---` 앞에 추가:

```markdown

**재확인 (2026-07-31 · 발주자)**
- 약관 전문 확인 완료 — 스냅샷: [`docs/legal/naver-terms-2026-07-31.md`](legal/naver-terms-2026-07-31.md).
  7.3③(허용 범위 초과 저장·가공·배포 금지)·검색 API 특약 2.1(독립 노출·왜곡 금지)·8조(결과
  데이터 권리) 문언 확인. 완화 요소(본문 미저장·30일 보관·집계 중심·재배포 없음)를 인지한
  상태에서 **"사용 가능" 결정 유지**.
- **API HUB 이관 확정** (약관 부칙): 개발자센터 Search API 신규 접수 2026-07-30 24:00 중단.
  발주자는 7/30 이전 등록(기존 이용자) — **2027-06-30 까지 legacy 이용 가능.** 그 전에
  `variant: "apihub"` 이관 필요. 자격증명 실동작 확인(2026-07-31 · HTTP 200).
```

- [ ] **Step 6: 통과 확인**

Run: `pnpm exec vitest run --config vitest.pg.config.ts packages/db/src/schema.pg.test.ts` → PASS
Run: `pnpm typecheck` → PASS

- [ ] **Step 7: 커밋** (스테이징된 약관 스냅샷 포함)

```bash
git add docs/legal/naver-terms-2026-07-31.md docs/03-decisions.md \
  packages/core/src/sourceRegistry.ts packages/db/migrations/0016_naver_approval.sql \
  packages/db/src/schema.pg.test.ts
git commit -m "D-002 재확인 기록 — 약관 스냅샷 · 승인 정합(0016) · legacy 기한 2027-06-30"
```

---

### Task 2: verifyNaver 하네스 + fixture 녹화 + verifiedAgainstLiveApi

**Files:**
- Modify: `packages/adapters/src/verify.ts` (VerifyOptions · verifyNaver · verifyAdapters:742-744)
- Modify: `apps/spike/src/index.ts:116-121` (자격증명 전달)
- Modify: `packages/adapters/src/search.ts:112-113` (verifiedAgainstLiveApi)
- Create: `packages/adapters/src/naver.fixture.test.ts`
- Create: `packages/adapters/src/verify.test.ts`
- Create(녹화): `fixtures/http/naver-search-{blog,cafearticle,webkr,news}.json`

**Interfaces:**
- Consumes: `parseNaverResponse`·`ORS_CHANNELS`(search.ts), `recordFixture` 패턴·`FIXTURE_ITEMS`·`CheckResult`·`AdapterVerification`(verify.ts)
- Produces: `VerifyOptions.naver?: { clientId: string; clientSecret: string }` · `verifyNaver(options): Promise<AdapterVerification>` (adapter: "naver_search")

- [ ] **Step 1: skip 경로 단위 테스트 (실패 확인용)** — `packages/adapters/src/verify.test.ts`:

```typescript
import { nullLogger } from "@leadops/core";
import type { HttpClient } from "@leadops/http";
import { describe, expect, it } from "vitest";
import { verifyNaver } from "./verify";

describe("verifyNaver", () => {
  it("자격증명이 없으면 fail 이 아니라 skip 이다 (검색 어댑터는 선택적)", async () => {
    // skip 경로는 HTTP 를 만지지 않아야 한다 — 만지면 여기서 던져서 실패한다.
    const http = new Proxy({} as HttpClient, {
      get() {
        throw new Error("skip 경로가 HTTP 를 호출했습니다");
      },
    });
    const result = await verifyNaver({ http, serviceKey: "", logger: nullLogger });
    expect(result.adapter).toBe("naver_search");
    expect(result.status).toBe("skip");
    expect(result.checks.some((c) => c.status === "fail")).toBe(false);
  });
});
```

Run: `pnpm exec vitest run packages/adapters/src/verify.test.ts`
Expected: FAIL — `verifyNaver` 미정의

- [ ] **Step 2: verify.ts 구현**

import 에 추가 (기존 import 뒤):

```typescript
import { ORS_CHANNELS, parseNaverResponse } from "./search";
```

`VerifyOptions` 에 필드 추가 (`fixtureDir` 다음):

```typescript
  /** 네이버 검증용 자격증명. 없으면 verifyNaver 는 skip 을 돌려준다 (fail 아님). */
  naver?: { clientId: string; clientSecret: string };
```

파일 하단 `verifyAdapters` **앞**에 추가:

```typescript
// ── 네이버 검색 ──────────────────────────────────────────────────────────────

const NAVER_VERIFY_KEYWORD = "강남 피부과";
const NAVER_BASE = "https://openapi.naver.com/v1/search";

/**
 * 네이버 응답은 items 가 최상위에 있다 (data.go.kr 봉투와 다름).
 * 회귀에 필요한 만큼만 남긴다 — total 은 검증 결과 자체이므로 자르지 않는다.
 */
function recordNaverFixture(dir: string | undefined, name: string, body: string): string | undefined {
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  let out = body;
  try {
    const doc = JSON.parse(body) as Record<string, any>;
    if (Array.isArray(doc?.["items"])) {
      doc["items"] = doc["items"].slice(0, FIXTURE_ITEMS);
      doc["display"] = Math.min(FIXTURE_ITEMS, doc["items"].length);
      out = `${JSON.stringify(doc, null, 2)}\n`;
    }
  } catch {
    // JSON 이 아니면 원문 그대로 — 형태를 모르는 응답일수록 원본이 중요하다.
  }
  writeFileSync(path, out, "utf8");
  return path;
}

/**
 * 네이버 검색 어댑터 검증 (설계서 11장 · D-002).
 *
 * ❗ 자격증명이 없으면 **skip** 이다. 검색 어댑터는 선택적이고 축소 파이프라인이
 *    1급 경로이므로, 키가 없는 환경(CI)에서 fail 을 내면 안 된다.
 */
export async function verifyNaver(options: VerifyOptions): Promise<AdapterVerification> {
  const { http, logger, fixtureDir, naver } = options;
  const checks: CheckResult[] = [];

  if (!naver?.clientId || !naver?.clientSecret) {
    checks.push({
      name: "자격증명",
      status: "skip",
      detail:
        "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 없어 건너뜁니다. " +
        "검색 어댑터는 선택적입니다 (축소 파이프라인이 1급 경로).",
    });
    return { adapter: "naver_search", checks, status: "skip" };
  }

  for (const channel of ORS_CHANNELS) {
    const url = new URL(`${NAVER_BASE}/${channel}.json`);
    url.searchParams.set("query", NAVER_VERIFY_KEYWORD);
    url.searchParams.set("display", "5");
    try {
      const res = await http.get(url.href, {
        headers: {
          "X-Naver-Client-Id": naver.clientId,
          "X-Naver-Client-Secret": naver.clientSecret,
        },
        acceptContentTypes: ["application/json", "text/json"],
      });
      // 파서가 실응답을 해석하는지가 검증의 본체다 — 여기서 던지면 fail 로 기록된다.
      const result = parseNaverResponse(channel, NAVER_VERIFY_KEYWORD, res.body);
      const fixture = recordNaverFixture(fixtureDir, `naver-search-${channel}`, res.body);
      checks.push({
        name: `${channel} 응답·파싱`,
        status: "pass",
        detail: `total ${result.total} · hits ${result.hits.length} — 파서가 실응답을 해석했습니다.`,
        ...(fixture ? { evidence: `fixture: ${fixture}` } : {}),
      });
      logger.info("verify.naver", { channel, total: result.total, hits: result.hits.length });
    } catch (err) {
      checks.push({
        name: `${channel} 응답·파싱`,
        status: "fail",
        detail: err instanceof LeadOpsError ? `${err.code}: ${err.message}` : String(err),
      });
    }
  }

  return { adapter: "naver_search", checks, status: overall(checks) };
}
```

`verifyAdapters` 를:

```typescript
export async function verifyAdapters(options: VerifyOptions): Promise<AdapterVerification[]> {
  return [await verifyHira(options), await verifyFtc(options), await verifyNaver(options)];
}
```

- [ ] **Step 3: spike 에 자격증명 전달** — `apps/spike/src/index.ts` 의 `verifyAdapters({...})` 인자에 추가:

```typescript
        ...(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET
          ? { naver: { clientId: env.NAVER_CLIENT_ID, clientSecret: env.NAVER_CLIENT_SECRET } }
          : {}),
```

- [ ] **Step 4: skip 테스트 통과 확인**

Run: `pnpm exec vitest run packages/adapters/src/verify.test.ts` → PASS
Run: `pnpm typecheck` → PASS

- [ ] **Step 5: 실키로 검증·녹화 실행** (.env 에 키 있음 — `FEATURE_SOURCE=live` 상태)

Run: `pnpm spike verify`
Expected: naver_search 4채널 전부 **pass** + `fixtures/http/naver-search-{blog,cafearticle,webkr,news}.json` 4개 생성. (HIRA pass · FTC fail 은 기존 상태 그대로 — FTC fail 로 종료 코드 1 이 나와도 naver 섹션이 pass 면 이 태스크는 성공이다. 출력 전문을 보고서에 담아라.)

- [ ] **Step 6: fixture 회귀 테스트** — `packages/adapters/src/naver.fixture.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ORS_CHANNELS, parseNaverResponse } from "./search";

/**
 * 네이버 검색 회귀 — **실제 API 응답**으로 파서를 검증한다.
 *
 * `fixtures/http/naver-search-*.json` 은 `pnpm spike verify` 가 실키로 받아 녹화한
 * 진짜 응답이다 (2026-07-31). 네이버가 필드명·형태를 바꾸면 여기서 깨진다 —
 * 그것이 이 테스트의 목적이다. (hira.fixture.test.ts 와 같은 방식)
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/http/", import.meta.url));
const load = (name: string): string => readFileSync(join(FIXTURES, `${name}.json`), "utf8");

describe("네이버 검색 회귀 — 실응답 fixture (2026-07-31 녹화)", () => {
  for (const channel of ORS_CHANNELS) {
    it(`${channel}: 파서가 실응답을 해석한다`, () => {
      const result = parseNaverResponse(channel, "강남 피부과", load(`naver-search-${channel}`));
      expect(result.total).toBeGreaterThan(0);
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0]!.link).toMatch(/^https?:/);
    });
  }

  it("blog 응답에 발행일이 있다 (postdate — 활동성·최신성 신호의 근거)", () => {
    const result = parseNaverResponse("blog", "강남 피부과", load("naver-search-blog"));
    expect(result.hits.some((h) => h.publishedAt instanceof Date)).toBe(true);
  });
});
```

- [ ] **Step 7: verifiedAgainstLiveApi 전환** — `search.ts:112-113` 을:

```typescript
  /** ✅ 실 API 응답으로 검증됨 (2026-07-31 · `pnpm spike verify` — fixture 회귀 테스트 있음). */
  readonly verifiedAgainstLiveApi = true;
```

- [ ] **Step 8: 전체 확인**

Run: `pnpm exec vitest run packages/adapters/src` → PASS (신규 fixture 회귀 5 + skip 1 포함)
Run: `pnpm typecheck` → PASS

- [ ] **Step 9: 커밋**

```bash
git add packages/adapters/src/verify.ts packages/adapters/src/verify.test.ts \
  packages/adapters/src/naver.fixture.test.ts packages/adapters/src/search.ts \
  apps/spike/src/index.ts fixtures/http/naver-search-*.json
git commit -m "verifyNaver — 4채널 실검증·fixture 녹화 · verifiedAgainstLiveApi 전환"
```

---

### Task 3: shadow 전환 + 소량 live 스모크

**Files:**
- Modify: `.env` (로컬 전용 — 커밋 금지): `FEATURE_ORS=off` → `FEATURE_ORS=shadow`

**Interfaces:**
- Consumes: Task 1 (코드 레지스트리 승인 — `assertSourceApproved` 통과), Task 2 (검증된 어댑터)

- [ ] **Step 1: .env 전환**

`.env` 의 `FEATURE_ORS=off` 를 `FEATURE_ORS=shadow` 로. (`.env.example` 은 무변경 — 기본값 off 유지가 문서화된 설계다)

- [ ] **Step 2: 소량 live 스모크** — search_analyze 가 skip 이 아니라 **산출**하는지

```powershell
$env:WORKER_DATABASE_URL='postgres://leadops_worker:leadops-worker-dev@127.0.0.1:55432/leadops'; `
  pnpm worker run --industry=derm --limit 20
```

Expected: 실행이 끝까지 돌고 (`상태: succeeded` 또는 `partial`), 워커 로그에 `ors.disabled` 가 **없어야** 한다. 이 실행은 live 수집(HIRA)·live 홈페이지 fetch·네이버 호출을 포함한다 — 수 분 걸릴 수 있다.

- [ ] **Step 3: shadow 산출 확인**

```powershell
docker exec leadops-pg psql -U postgres -d leadops -c "
select provider, count(*), count(ors) as with_ors
from search_aggregates
where collected_at > now() - interval '1 hour'
group by provider order by provider;"
```

Expected: 이번 실행의 `search_aggregates` 행이 존재 (게이트 통과 업체가 있으면 4채널 분포).
행이 0 인 경우 — 20건 중 공식 홈페이지 판정·키워드 승인까지 간 업체가 없어 search_analyze
대상이 0 일 수 있다. 그 경우 `run_stages` 에서 `search_analyze` 가 `skipped` 가 아니라
`succeeded`(대상 0) 인지 확인하고, 그 사실을 보고서에 담아라 (skip = 어댑터 미로드 = 실패,
대상 0 = 정상):

```powershell
docker exec leadops-pg psql -U postgres -d leadops -c "
select stage, status, total, done from run_stages
where attempt_id = (select id from run_attempts order by started_at desc nulls last limit 1)
  and stage in ('search_analyze','homepage_discover') order by stage;"
```

- [ ] **Step 4: cost_ledger 선점 확인** (쿼터 가드가 네이버 호출을 원장에 적었는지)

```powershell
docker exec leadops-pg psql -U postgres -d leadops -c "
select provider, sum(qty) from cost_ledger
where day = (now() at time zone 'Asia/Seoul')::date and provider like 'naver%'
group by provider;"
```

Expected: `naver_search`(또는 naver 접두 provider) 사용량 > 0 (homepage_discover 지역검색 또는 search_analyze 호출분)

- [ ] **Step 5: 보고** — 커밋 없음 (.env 는 커밋 금지). 보고서에 스모크 결과(실행 상태·스테이지 상태·aggregates/원장 수치)를 담는다.

---

## 계획 밖 (컨트롤러 후속 — SDD 태스크 아님)

**전체 실측 (M1·M6 재측정)**: `pnpm worker run --industry=derm,plastic,dental` 전체 규모(기본 limit 500)는 live 크롤로 **수 시간**이 걸린다 — 컨트롤러가 백그라운드로 실행하고, 완료 후 `pnpm spike measure --goldset out/sample-seed42.csv` 로 M1(기존 18.9%)·M6(기존 0%) 재측정값을 보고한다. 라벨 의존 지표는 여전히 `미측정`.

## Self-Review 결과

- **스펙 커버리지**: A(기록) = Task 1 + 스테이징된 약관 스냅샷(Task 1 커밋에 포함) · B(하네스) = Task 2 (skip 규칙·fixture 관례·플래그 전환 순서 포함) · C(전환·실측) = Task 3 + 계획 밖 절(전체 실측 분리 — 스펙 완료 기준 중 "measure 재측정 보고"는 컨트롤러 후속으로 이행). 범위 밖 3건은 스펙과 동일하게 제외.
- **플레이스홀더**: 없음.
- **타입 일관성**: `VerifyOptions.naver` 형태 = spike 전달부 = verifyNaver 소비부 일치. `verifyNaver` 시그니처 = verify.test.ts 사용부 일치. fixture 파일명 `naver-search-<channel>` = 녹화부 = 회귀 테스트 load 일치 (channel 은 `ORS_CHANNELS` = blog·cafearticle·webkr·news).
