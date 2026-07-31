import type { SearchAdapter, SearchProvider, SearchResult } from "@leadops/adapters";
import { nullLogger } from "@leadops/core";
import { createRun, createTestDb, type TestDb } from "@leadops/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homepageDiscoverStage } from "./homepageDiscover";
import type { StageContext } from "./types";

/**
 * 홈페이지 발견 — DB 까지 포함한 동작.
 *
 * ❗ 확인할 것은 "URL 이 저장되는가" 가 아니라 **근거 없는 URL 이 저장되지 않는가** 다.
 *    엉뚱한 사이트를 그 업체 것으로 저장하면 점수·취약점·추천이 전부 다른 업체 기준으로
 *    계산되고, 검수자는 그 사실을 알 방법이 없다.
 */

let db: TestDb;
let runId: string;
let attemptId: string;
let runDate: string;

beforeAll(async () => {
  db = await createTestDb("discover");
  const run = await createRun(db);
  runId = run.runId;
  attemptId = run.attemptId;
  runDate = run.runDate;
}, 180_000);

afterAll(async () => {
  await db.close();
});

/** 지역검색 결과를 고정해 주는 어댑터. 자격증명 없이 스테이지를 검증한다. */
function stubAdapter(hitsByQuery: Record<string, SearchResult["hits"]>, opts: { fail?: boolean } = {}): SearchAdapter {
  return {
    sourceName: "naver_search",
    verifiedAgainstLiveApi: false,
    unitsPerCall: 1,
    async search(provider: SearchProvider, keyword: string): Promise<SearchResult> {
      if (opts.fail) throw new Error("네이버 응답 손상");
      return { provider, keyword, total: 0, hits: hitsByQuery[keyword] ?? [] };
    },
  };
}

/** 업체 하나를 만든다 (URL 없음 — 발견 대상). */
async function company(over: { name: string; phone?: string | null; sigungu?: string | null }): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const [row] = await db.owner<Array<{ id: string }>>`
    insert into companies (dedupe_key, name, normalized_name, industry, region_sido, region_sigungu, phone, address)
    values (${`dk-${suffix}`}, ${over.name}, ${over.name}, 'derm', '서울특별시',
            ${over.sigungu ?? "강남구"}, ${over.phone ?? null}, '서울특별시 강남구 테헤란로 1')
    returning id
  `;
  const id = row!.id;
  // 발견 스테이지는 이번 attempt 의 관측이 있는 업체만 본다.
  await db.owner`
    insert into company_observations (company_id, attempt_id, run_date, status, content_fingerprint, track)
    values (${id}, ${attemptId}, ${runDate}::date, 'active', ${`fp-${suffix}`}, 'new')
  `;
  return id;
}

const ctx = (search: SearchAdapter | undefined): StageContext => ({
  sql: db.owner,
  runId,
  attemptId,
  runDate,
  // `quotaSettingsFrom` 은 세 쿼터를 모두 요구한다 (누락은 configuration_error).
  settings: {
    quota: { naver_daily_cap: 20000, youtube_daily_units: 9000, data_go_kr_daily_cap: 9000 },
  },
  logger: nullLogger,
  adapters: [],
  ...(search === undefined ? {} : { search }),
});

const hit = (over: Partial<SearchResult["hits"][number]> = {}) => ({
  rank: 1,
  title: "강남삼성피부과의원",
  link: "https://gangnam-samsung.co.kr",
  description: "",
  telephone: "02-555-1234",
  address: "서울특별시 강남구 역삼동 1",
  roadAddress: "서울특별시 강남구 테헤란로 1",
  ...over,
});

const websitesOf = (companyId: string) =>
  db.owner<Array<{ canonical_url: string; discovery_source: string | null; discovery_basis: string | null }>>`
    select canonical_url, discovery_source, discovery_basis from websites where company_id = ${companyId}
  `;

describe("homepage_discover", () => {
  it("어댑터가 없으면 실패가 아니라 건너뛴다", async () => {
    const result = await homepageDiscoverStage.run(ctx(undefined), {});
    expect(result.skipped["discovery_disabled"]).toBe(1);
    expect(result.passed).toBe(0);
  });

  it("전화가 일치하면 후보를 저장하고 근거를 남긴다", async () => {
    const id = await company({ name: "강남삼성피부과의원", phone: "02-555-1234" });
    const result = await homepageDiscoverStage.run(
      ctx(stubAdapter({ "강남구 강남삼성피부과의원": [hit()] })),
      {},
    );
    expect(result.passed).toBeGreaterThanOrEqual(1);

    const rows = await websitesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.canonical_url).toBe("https://gangnam-samsung.co.kr");
    expect(rows[0]?.discovery_source).toBe("naver_search");
    // ❗ 근거가 남아야 오판을 사후에 되짚을 수 있다.
    expect(rows[0]?.discovery_basis).toBe("phone_match");
  });

  it("❗ 근거가 없으면 저장하지 않는다 (동명이인)", async () => {
    const id = await company({ name: "부산해운대피부과의원", phone: "051-111-2222", sigungu: "해운대구" });
    const stranger = hit({
      title: "서울강남피부과의원",
      link: "https://someone-else.kr",
      telephone: "02-999-8888",
      address: "서울특별시 강남구 …",
      roadAddress: "서울특별시 강남구 …",
    });
    await homepageDiscoverStage.run(
      ctx(stubAdapter({ "해운대구 부산해운대피부과의원": [stranger] })),
      {},
    );
    await expect(websitesOf(id)).resolves.toHaveLength(0);
  });

  it("❗ 조회 실패를 '홈페이지 없음' 으로 기록하지 않는다", async () => {
    const id = await company({ name: "조회실패피부과의원", phone: "02-333-4444" });
    const result = await homepageDiscoverStage.run(ctx(stubAdapter({}, { fail: true })), {});
    expect(result.skipped["search_failed"]).toBeGreaterThanOrEqual(1);
    // 실패는 우리 문제이지 그 업체의 상태가 아니다 — 아무것도 남기지 않는다.
    await expect(websitesOf(id)).resolves.toHaveLength(0);
  });

  it("❗ 이미 URL 이 있는 업체는 건드리지 않는다 (공공 API 값을 검색 결과로 덮지 않는다)", async () => {
    const id = await company({ name: "이미있는피부과의원", phone: "02-555-1234" });
    await db.owner`
      insert into websites (company_id, canonical_url, domain)
      values (${id}, 'https://from-hira.kr', 'from-hira.kr')
    `;
    await homepageDiscoverStage.run(
      ctx(stubAdapter({ "강남구 이미있는피부과의원": [hit()] })),
      {},
    );
    const rows = await websitesOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.canonical_url).toBe("https://from-hira.kr");
    // 1차 수집원에서 온 URL 은 discovery_source 가 없다.
    expect(rows[0]?.discovery_source).toBeNull();
  });

  it("두 번 실행해도 같은 결과다 (멱등)", async () => {
    const id = await company({ name: "멱등피부과의원", phone: "02-777-1234" });
    const adapter = stubAdapter({
      "강남구 멱등피부과의원": [hit({ title: "멱등피부과의원", telephone: "02-777-1234" })],
    });
    await homepageDiscoverStage.run(ctx(adapter), {});
    await homepageDiscoverStage.run(ctx(adapter), {});
    await expect(websitesOf(id)).resolves.toHaveLength(1);
  });

  it("❗ 쿼터가 소진되면 그 자리에서 멈춘다", async () => {
    await company({ name: "쿼터소진피부과의원", phone: "02-888-1234" });
    const tight: StageContext = {
      ...ctx(stubAdapter({})),
      settings: {
        quota: { naver_daily_cap: 0, youtube_daily_units: 9000, data_go_kr_daily_cap: 9000 },
      },
    };
    const result = await homepageDiscoverStage.run(tight, {});
    expect(result.skipped["quota_exhausted"]).toBe(1);
    expect(result.note).toContain("쿼터 소진");
  });

  it("쿼터 선점이 cost_ledger 에 남는다 (합산 한도라 ORS 와 같은 provider 다)", async () => {
    const [row] = await db.owner<Array<{ n: string; provider: string }>>`
      select count(1)::text as n, min(provider) as provider
      from cost_ledger where entry_key like 'discover:%'
    `;
    expect(Number(row?.n ?? 0)).toBeGreaterThan(0);
    expect(row?.provider).toBe("naver_search");
  });
});
