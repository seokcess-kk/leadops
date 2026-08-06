# webkr 발견 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 지역검색이 근거를 못 찾은 업체에 대해 웹검색(webkr) 폴백으로 홈페이지 후보를 발견한다 (M1 보강).

**Architecture:** `homepageDiscovery.ts` 에 텍스트 근거 판별 함수를 추가하고, `homepage_discover` 스테이지의 업체 루프에서 local 채택 실패 시 webkr 1회를 폴백 호출한다. 별도 스테이지·스키마 변경 없음. 발견은 후보만 만들고 판정은 `homepage_detect` 다신호가 결정하는 구조 불변.

**Tech Stack:** TypeScript strict · vitest (단위 `pnpm test <파일>`, 통합 `pnpm test:db <파일>` — Postgres 컨테이너 `pnpm db:up` 선행) · postgres.js

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-08-06-webkr-discovery-design.md`
- 채택 basis 문자열은 정확히 `name_region_text`
- webkr `display` 는 10 · 쿼터 멱등 키는 `discover:webkr:{attemptId}:{companyId}`
- local 조회가 **에러**로 실패하면 webkr 를 시도하지 않는다 (근거 없어 채택 실패한 경우에만 폴백)
- 검색 순위는 근거가 아니다 — 텍스트 근거 통과분 안에서만 문서순 첫 건 채택
- 주석·커밋 메시지는 한국어, 기존 파일의 주석 밀도·어조를 따른다

---

### Task 1: 텍스트 근거 판별 — `discoverHomepageFromWebSearch`

**Files:**
- Modify: `packages/pipeline/src/official.ts` (titleNeedles 를 export — 106행 부근 `function titleNeedles` → `export function titleNeedles`)
- Modify: `packages/pipeline/src/homepageDiscovery.ts`
- Test: `packages/pipeline/src/homepageDiscovery.test.ts`

**Interfaces:**
- Consumes: `titleNeedles(normalized: string): string[]` (official.ts) · `normalizeCompanyName(raw: string): string` (normalize.ts) · `classifyDomain`/`isDisqualifyingClass` (aggregators.ts)
- Produces: `interface WebCandidate { title: string; link: string; description: string }` · `discoverHomepageFromWebSearch(known: KnownCompany, hits: readonly WebCandidate[]): DiscoveryResult` · `DiscoveryBasis` 에 `"name_region_text"` 추가 · `DiscoveryRejection` 에 `"no_text_evidence"` 추가

- [ ] **Step 1: 실패하는 테스트 작성**

`homepageDiscovery.test.ts` 끝에 추가:

```ts
describe("웹검색 폴백 — 텍스트 근거 (discoverHomepageFromWebSearch)", () => {
  const known = { name: "기장필피부과의원", phone: null, regionSigungu: "기장군" };

  it("상호(접미 완화)와 시군구가 제목·설명에 함께 나타나면 채택한다", () => {
    // 실사례 패턴: 사이트 제목은 종별 접미 없이 "기장필피부과" 로 적힌다.
    const r = discoverHomepageFromWebSearch(known, [
      { title: "기장필피부과 - 부산 기장군 피부과전문의", link: "https://feelskin.kr/", description: "" },
    ]);
    expect(r.url).toBe("https://feelskin.kr/");
    expect(r.basis).toBe("name_region_text");
  });

  it("❗ 상호만 맞으면 거절한다 — 동명이인", () => {
    const r = discoverHomepageFromWebSearch(known, [
      { title: "기장필피부과 예약 안내", link: "https://someone.kr/", description: "빠른 예약" },
    ]);
    expect(r.url).toBeUndefined();
    expect(r.rejected).toBe("no_text_evidence");
  });

  it("❗ 시군구만 맞으면 거절한다 — 옆 건물 다른 병원", () => {
    const r = discoverHomepageFromWebSearch(known, [
      { title: "기장군 피부 관리 잘하는 곳", link: "https://other.kr/", description: "기장군 추천" },
    ]);
    expect(r.rejected).toBe("no_text_evidence");
  });

  it("❗ 애그리게이터·SNS 링크는 텍스트가 맞아도 요청 전에 자른다", () => {
    const r = discoverHomepageFromWebSearch(known, [
      { title: "기장필피부과", link: "https://blog.naver.com/feelskin", description: "기장군" },
    ]);
    expect(r.url).toBeUndefined();
    expect(r.rejected).toBe("disqualifying_domain");
  });

  it("❗ 순위는 근거가 아니다 — 무근거 1위를 건너뛰고 근거 있는 2위를 채택한다", () => {
    const r = discoverHomepageFromWebSearch(known, [
      { title: "피부과 순위 TOP10", link: "https://rank.kr/", description: "전국" },
      { title: "기장필피부과 | 기장군", link: "https://feelskin.kr/", description: "" },
    ]);
    expect(r.url).toBe("https://feelskin.kr/");
  });

  it("시군구를 모르는 업체는 텍스트 근거가 성립하지 않는다", () => {
    const r = discoverHomepageFromWebSearch({ name: "기장필피부과의원", regionSigungu: null }, [
      { title: "기장필피부과 기장군", link: "https://feelskin.kr/", description: "" },
    ]);
    expect(r.rejected).toBe("no_text_evidence");
  });

  it("결과가 없으면 no_candidates 다", () => {
    expect(discoverHomepageFromWebSearch(known, []).rejected).toBe("no_candidates");
  });
});
```

import 줄에 `discoverHomepageFromWebSearch` 추가.

- [ ] **Step 2: 실패 확인**

Run: `pnpm test packages/pipeline/src/homepageDiscovery.test.ts`
Expected: FAIL — `discoverHomepageFromWebSearch` export 없음.

- [ ] **Step 3: 최소 구현**

`official.ts`: `function titleNeedles(` → `export function titleNeedles(` (주석에 "homepageDiscovery 의 웹검색 폴백도 같은 완화 규칙을 쓴다" 한 줄 추가).

`homepageDiscovery.ts`:

```ts
import { titleNeedles } from "./official";
import { normalizeCompanyName } from "./normalize";
```

타입 확장:

```ts
export type DiscoveryBasis = "phone_match" | "name_and_region_match" | "name_region_text";

export type DiscoveryRejection =
  | "no_candidates"
  | "no_link"
  | "disqualifying_domain"
  | "invalid_url"
  | "no_matching_evidence"
  | "no_text_evidence";

/** 웹검색(webkr) 한 건에서 판별에 쓰는 값. 전화·주소 필드가 없다 — 텍스트가 전부다. */
export interface WebCandidate {
  readonly title: string;
  readonly link: string;
  readonly description: string;
}
```

함수 (파일 끝, `discoveryQuery` 앞):

```ts
/**
 * 웹검색(webkr) 결과에서 홈페이지 후보를 고른다 — 지역검색 폴백.
 *
 * webkr 히트에는 전화·주소가 없어 지역검색의 근거(전화 일치)를 쓸 수 없다. 대신
 * 지역검색의 "상호 + 시군구 동시 일치"(약한 근거)와 동급을 **텍스트로 재현**한다:
 * 제목+설명에 상호(종별 접미 완화 — `titleNeedles`)와 시군구가 **함께** 나타나야 한다.
 *
 * ❗ 검색 순위는 근거가 아니다 — 텍스트 근거 통과분 안에서 문서순 첫 건만 쓴다.
 */
export function discoverHomepageFromWebSearch(
  known: KnownCompany,
  hits: readonly WebCandidate[],
): DiscoveryResult {
  if (hits.length === 0) return { rejected: "no_candidates", considered: 0 };

  const normalized = normalizeCompanyName(known.name);
  const sigungu = normalizeCompanyName((known.regionSigungu ?? "").trim());
  const needles = normalized.length >= 3 ? titleNeedles(normalized) : [];

  let rejection: DiscoveryRejection = "no_text_evidence";

  for (const hit of hits) {
    if (!hit.link) {
      rejection = "no_link";
      continue;
    }
    const host = hostOf(hit.link);
    if (host === undefined) {
      rejection = "invalid_url";
      continue;
    }
    if (isDisqualifyingClass(classifyDomain(host))) {
      rejection = "disqualifying_domain";
      continue;
    }

    // 상호와 시군구가 **함께** 있어야 한다. 시군구를 모르면 근거가 성립하지 않는다.
    if (sigungu === "" || needles.length === 0) continue;
    const hay = normalizeCompanyName(`${hit.title} ${hit.description}`);
    if (!needles.some((n) => hay.includes(n))) continue;
    if (!hay.includes(sigungu)) continue;

    return { url: hit.link, basis: "name_region_text", considered: hits.length };
  }

  return { rejected: rejection, considered: hits.length };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm test packages/pipeline/src/homepageDiscovery.test.ts packages/pipeline/src/official.test.ts`
Expected: PASS (official 기존 22건 포함).

- [ ] **Step 5: 커밋**

```bash
git add packages/pipeline/src/homepageDiscovery.ts packages/pipeline/src/homepageDiscovery.test.ts packages/pipeline/src/official.ts
git commit -m "웹검색 폴백 판별 — 텍스트 근거 (상호 접미 완화 + 시군구 동시 포함)"
```

---

### Task 2: 스테이지 폴백 — local 실패 시 webkr 1회

**Files:**
- Modify: `packages/pipeline/src/stages/homepageDiscover.ts` (업체 루프 127~186행)
- Test: `packages/pipeline/src/stages/homepageDiscover.pg.test.ts`

**Interfaces:**
- Consumes: `discoverHomepageFromWebSearch(known, hits)` · `WebCandidate` (Task 1) · `adapter.search("webkr", query, 10)` → `SearchResult`(hits 에 title/link/description)
- Produces: skip 카운터 `webkr_search_failed` · `webkr_no_text_evidence` 등 (`webkr_` 접두) · 쿼터 entry_key `discover:webkr:{attemptId}:{companyId}`

- [ ] **Step 1: 실패하는 테스트 작성**

`homepageDiscover.pg.test.ts` 의 `stubAdapter` 를 provider 인식으로 확장 (기존 호출부는 그대로 동작해야 한다):

```ts
/** 지역·웹검색 결과를 고정해 주는 어댑터. `${provider}:${keyword}` 키가 우선, 없으면 keyword 키(기존 local 테스트 호환). */
function stubAdapter(
  hitsByQuery: Record<string, SearchResult["hits"]>,
  opts: { fail?: boolean; failProvider?: string } = {},
): SearchAdapter & { calls: Array<{ provider: string; keyword: string }> } {
  const calls: Array<{ provider: string; keyword: string }> = [];
  return {
    sourceName: "naver_search",
    verifiedAgainstLiveApi: false,
    unitsPerCall: 1,
    calls,
    async search(provider: SearchProvider, keyword: string): Promise<SearchResult> {
      calls.push({ provider, keyword });
      if (opts.fail || opts.failProvider === provider) throw new Error("네이버 응답 손상");
      const hits = hitsByQuery[`${provider}:${keyword}`] ?? hitsByQuery[keyword] ?? [];
      return { provider, keyword, total: 0, hits };
    },
  };
}
```

테스트 추가 (`두 번 실행해도 같은 결과다` 앞):

```ts
it("❗ 지역검색이 근거를 못 찾으면 웹검색으로 폴백해 텍스트 근거로 채택한다", async () => {
  const id = await company({ name: "웹폴백피부과의원", phone: "02-000-1111" });
  const adapter = stubAdapter({
    // local 은 전화도 상호+주소도 안 맞는 히트만 준다 → 채택 실패
    "강남구 웹폴백피부과의원": [hit({ title: "다른의원", telephone: "02-999-0000", address: "부산" })],
    // webkr 는 텍스트 근거가 있는 히트를 준다
    "webkr:강남구 웹폴백피부과의원": [
      { rank: 1, title: "웹폴백피부과 | 강남구", link: "https://webfallback.kr/", description: "" },
    ],
  });
  const result = await homepageDiscoverStage.run(ctx(adapter), {});
  const rows = await websitesOf(id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.canonical_url).toBe("https://webfallback.kr/");
  expect(rows[0]?.discovery_basis).toBe("name_region_text");
  expect(result.passed).toBeGreaterThanOrEqual(1);
});

it("❗ 지역검색이 채택하면 웹검색을 호출하지 않는다 — 쿼터를 아낀다", async () => {
  await company({ name: "로컬성공피부과의원", phone: "02-555-1234" });
  const adapter = stubAdapter({
    "강남구 로컬성공피부과의원": [hit({ title: "로컬성공피부과의원", telephone: "02-555-1234" })],
  });
  await homepageDiscoverStage.run(ctx(adapter), {});
  const webCalls = adapter.calls.filter(
    (c) => c.provider === "webkr" && c.keyword === "강남구 로컬성공피부과의원",
  );
  expect(webCalls).toHaveLength(0);
});

it("❗ 웹검색 조회 실패를 '홈페이지 없음' 으로 기록하지 않는다", async () => {
  const id = await company({ name: "웹조회실패피부과의원", phone: "02-000-3333" });
  const result = await homepageDiscoverStage.run(
    ctx(stubAdapter({}, { failProvider: "webkr" })),
    {},
  );
  await expect(websitesOf(id)).resolves.toHaveLength(0);
  expect(result.skipped["webkr_search_failed"]).toBeGreaterThanOrEqual(1);
});

it("웹검색도 근거가 없으면 저장하지 않고 사유를 남긴다", async () => {
  const id = await company({ name: "양쪽실패피부과의원", phone: "02-000-2222" });
  const result = await homepageDiscoverStage.run(
    ctx(stubAdapter({ "webkr:강남구 양쪽실패피부과의원": [
      { rank: 1, title: "무관한 페이지", link: "https://unrelated.kr/", description: "" },
    ] })),
    {},
  );
  await expect(websitesOf(id)).resolves.toHaveLength(0);
  expect(result.skipped["webkr_no_text_evidence"]).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test:db packages/pipeline/src/stages/homepageDiscover.pg.test.ts`
Expected: FAIL — 웹폴백 테스트에서 websites 0건 (폴백 미구현).

- [ ] **Step 3: 최소 구현**

`stages/homepageDiscover.ts` 상단에 상수·import 추가:

```ts
import {
  discoverHomepage,
  discoverHomepageFromWebSearch,
  discoveryQuery,
  type DiscoveryRejection,
  type KnownCompany,
  type LocalCandidate,
  type WebCandidate,
} from "../homepageDiscovery";

/** 웹검색 폴백 결과 상한. 텍스트 근거 필터라 상위권만 의미가 있다. */
const WEB_DISPLAY = 10;
```

업체 루프에서 기존 채택/거절 분기(169~186행)를 다음으로 교체:

```ts
        const discovery = discoverHomepage(known, candidates);
        let adopted =
          discovery.url === undefined ? undefined : { url: discovery.url, basis: discovery.basis ?? null };

        // ── webkr 폴백 ──
        // 조회는 됐으나 **근거가 없어** 채택에 실패한 경우에만 시도한다. 조회 에러는
        // 위의 catch 가 이미 search_failed 로 남기고 continue 했다 (설계 문서 B절).
        if (adopted === undefined) {
          const webReserved = await quota.reserve(
            CALLS_PER_COMPANY,
            `discover:webkr:${ctx.attemptId}:${target.company_id}`,
          );
          if (!webReserved.granted) {
            exhausted = true;
            countSkip(result, "quota_exhausted");
            ctx.logger.warn("stage.discover.quota_exhausted", {
              provider: quota.provider,
              used: webReserved.used,
              cap: webReserved.cap,
            });
            break;
          }
          try {
            const web = await adapter.search("webkr", discoveryQuery(known), WEB_DISPLAY);
            const webHits: WebCandidate[] = web.hits.map((h) => ({
              title: h.title,
              link: h.link,
              description: h.description,
            }));
            const webDiscovery = discoverHomepageFromWebSearch(known, webHits);
            if (webDiscovery.url !== undefined) {
              adopted = { url: webDiscovery.url, basis: webDiscovery.basis ?? null };
            } else {
              countSkip(result, `webkr_${webDiscovery.rejected ?? "no_text_evidence"}`);
            }
          } catch (err) {
            countSkip(result, "webkr_search_failed");
            ctx.logger.warn("stage.discover.webkr_failed", {
              companyId: target.company_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (adopted === undefined) {
          countSkip(result, discovery.rejected ?? ("no_matching_evidence" satisfies DiscoveryRejection));
          continue;
        }

        const host = new URL(adopted.url).hostname.toLowerCase().replace(/^www\./, "");
        // ❗ 멱등하다. 잡이 재시도돼도 같은 행이 두 번 생기지 않는다.
        await ctx.sql`
          insert into websites (company_id, canonical_url, domain,
                                discovery_source, discovery_basis, discovered_at)
          values (${target.company_id}, ${adopted.url}, ${host},
                  ${adapter.sourceName}, ${adopted.basis}, now())
          on conflict (company_id, domain) do nothing
        `;
        found++;
        result.passed++;
```

(주의: skip 카운터는 처리 건수의 분할이 아니다 — 한 업체가 `webkr_no_text_evidence` 와 local 거절 사유를 함께 남길 수 있다. 진단용 계수이므로 의도된 동작.)

파일 머리 doc 주석의 흐름 설명에 한 줄 추가: "지역검색이 근거를 못 찾으면 웹검색(webkr)으로 1회 폴백한다 — 텍스트 근거(상호 접미 완화 + 시군구 동시 포함)."

- [ ] **Step 4: 통과 확인**

Run: `pnpm test:db packages/pipeline/src/stages/homepageDiscover.pg.test.ts`
Expected: PASS (기존 10건 + 신규 4건 = 14건).

- [ ] **Step 5: 커밋**

```bash
git add packages/pipeline/src/stages/homepageDiscover.ts packages/pipeline/src/stages/homepageDiscover.pg.test.ts
git commit -m "homepage_discover — 지역검색 근거 실패 시 webkr 텍스트 근거 폴백"
```

---

### Task 3: 문서 갱신 · 전체 검증 · PR

**Files:**
- Modify: `README.md` (파이프라인 절의 `homepage_discover` 설명 — "URL 없는 업체만 · 지역검색 · 전화/상호+지역 일치만 채택" 부근)

**Interfaces:**
- Consumes: Task 1·2 완료 상태
- Produces: PR (feat/webkr-discovery → master)

- [ ] **Step 1: README 파이프라인 절 갱신**

`homepage_discover` 설명을 "평가할 후보 없는 업체만 · 지역검색(전화/상호+지역) → 실패 시 웹검색(상호+시군구 텍스트) 폴백 · 채택만, 판정은 다신호" 취지로 수정. 발견 절(### 홈페이지 발견)에도 webkr 폴백 문단 추가 — 근거 표에 `상호+시군구 텍스트 동시 일치 (webkr 폴백) | 채택 (약한 근거)` 행 추가.

- [ ] **Step 2: 전체 검증**

Run: `pnpm typecheck && pnpm test && pnpm test:db`
Expected: 전부 PASS.

- [ ] **Step 3: 커밋 · 푸시 · PR**

```bash
git add README.md
git commit -m "README — homepage_discover webkr 폴백 반영"
git push -u origin feat/webkr-discovery
gh pr create --title "webkr 발견 폴백 — 텍스트 근거로 M1 보강" --body "스펙: docs/superpowers/specs/2026-08-06-webkr-discovery-design.md

지역검색이 근거(전화 일치·상호+시군구)를 못 찾은 업체에 대해 webkr 1회 폴백.
채택은 텍스트 근거(상호 접미 완화 + 시군구 동시 포함)만 · 애그리게이터 사전 제거 ·
통과분 내 문서순 첫 건 · discovery_basis='name_region_text' 로 사후 분리 검증 가능.
발견은 후보만 만들고 판정은 homepage_detect 다신호가 결정 (불변).

측정 계획: 머지 후 재크롤 → spike measure 로 M1 재측정, basis 별 정확도 분리 확인."
```
