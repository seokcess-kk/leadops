import { MockSearchAdapter } from "@leadops/adapters";
import { nullLogger } from "@leadops/core";
import { createRun, createTestDb, relativeDate, type TestDb } from "@leadops/db";
import { RobotsGate, type FetchResult, type HttpClient } from "@leadops/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QuotaGuard, quotaSettingsFrom } from "../quota";
import { channelStage } from "./channel";
import { searchStage } from "./search";
import type { StageContext } from "./types";

/**
 * Phase 4 통합 — 쿼터 가드 · 채널 활성도 · 검색(ORS).
 *
 * 실제 Postgres 를 쓴다. HTTP 는 가짜 클라이언트로 대체하되 **robots 게이트는 진짜**다
 * (피드 주소는 플랫폼이 정한 고정 패턴이라 테스트 포트를 끼워 넣을 수 없다).
 * 실 네트워크 경로는 `homepage.pg.test.ts` 가 이미 검증한다.
 */

let db: TestDb;

const RSS = (dates: readonly string[]): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>공식블로그</title>${dates
    .map((d, i) => `<item><title>글 ${i} 이벤트</title><pubDate>${d}</pubDate></item>`)
    .join("")}</channel></rss>`;

/** 요청 URL 로 응답을 고르는 가짜 클라이언트. */
function fakeHttp(routes: (url: string) => Partial<FetchResult> | undefined): {
  http: HttpClient;
  calls: string[];
} {
  const calls: string[] = [];
  const http = {
    async get(url: string): Promise<FetchResult> {
      calls.push(url);
      const hit = routes(url);
      if (!hit) throw new Error(`no route: ${url}`);
      return { status: 200, finalUrl: url, headers: {}, body: "", hops: [], truncated: false, ...hit };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

beforeAll(async () => {
  db = await createTestDb("phase4");
}, 60_000);

afterAll(async () => {
  await db?.close();
});

// ────────────────────────────────────────────────────────────── 쿼터

describe("❗ 쿼터 가드 — 호출 전에 선점한다", () => {
  const spec = { provider: "test_api", dailyCap: 10, unit: "call" };

  it("한도 안에서는 선점된다", async () => {
    const { runId } = await createRun(db, "2026-10-01");
    const guard = new QuotaGuard(db.owner, runId, spec);
    const first = await guard.reserve(3, `${runId}:a`);
    expect(first.granted).toBe(true);
    expect(first.used).toBe(3);
  });

  it("❗ 같은 키로 다시 선점해도 이중 계상되지 않는다 (잡 재시도)", async () => {
    const { runId } = await createRun(db, "2026-10-02");
    const guard = new QuotaGuard(db.owner, runId, { ...spec, provider: "retry_api" });
    await guard.reserve(4, `${runId}:same`);
    const again = await guard.reserve(4, `${runId}:same`);
    expect(again.replayed).toBe(true);
    expect(again.granted).toBe(true);
    expect(await guard.usedToday()).toBe(4);
  });

  it("❗ 한도를 넘으면 던지지 않고 거절한다 (쿼터 소진은 오류가 아니다)", async () => {
    const { runId } = await createRun(db, "2026-10-03");
    const guard = new QuotaGuard(db.owner, runId, { ...spec, provider: "cap_api", dailyCap: 5 });
    expect((await guard.reserve(4, `${runId}:1`)).granted).toBe(true);
    const denied = await guard.reserve(4, `${runId}:2`);
    expect(denied.granted).toBe(false);
    expect(denied.used).toBe(4);
    expect(denied.cap).toBe(5);
    // 거절된 선점은 원장에 남지 않는다.
    expect(await guard.usedToday()).toBe(4);
  });

  it("❗ 동시 선점이 한도를 넘지 않는다", async () => {
    const { runId } = await createRun(db, "2026-10-04");
    const guard = new QuotaGuard(db.owner, runId, { ...spec, provider: "race_api", dailyCap: 10 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => guard.reserve(2, `${runId}:r${i}`)),
    );
    const granted = results.filter((r) => r.granted).length;
    expect(granted).toBe(5); // 2 × 5 = 10
    expect(await guard.usedToday()).toBe(10);
  });

  it("provider 마다 따로 센다", async () => {
    const { runId } = await createRun(db, "2026-10-05");
    const a = new QuotaGuard(db.owner, runId, { ...spec, provider: "sep_a" });
    const b = new QuotaGuard(db.owner, runId, { ...spec, provider: "sep_b" });
    await a.reserve(9, `${runId}:a`);
    expect((await b.reserve(9, `${runId}:b`)).granted).toBe(true);
  });

  it("설정이 없거나 범위를 벗어나면 통과가 아니라 에러다", () => {
    expect(() => quotaSettingsFrom({})).toThrow(/quota/);
    expect(() => quotaSettingsFrom({ quota: { naver_daily_cap: -1 } })).toThrow(/naver_daily_cap/);
  });

  it("시드 설정을 읽는다", async () => {
    const [row] = await db.owner<Array<{ value: Record<string, unknown> }>>`
      select value from settings where key = 'quota'
    `;
    const parsed = quotaSettingsFrom({ quota: row!.value });
    expect(parsed.naverDailyCap).toBe(20000);
    expect(parsed.youtubeDailyUnits).toBe(9000);
  });
});

// ────────────────────────────────────────────────────────────── 채널

describe("channel_analyze — 공식 채널 활성도", () => {
  let runId: string;
  let attemptId: string;
  let runDate: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const run = await createRun(db, relativeDate(1));
    runId = run.runId;
    attemptId = run.attemptId;
    runDate = run.runDate;

    const seed = async (name: string, channels: Array<[string, string]>): Promise<string> => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const [company] = await db.owner<{ id: string }[]>`
        insert into companies (dedupe_key, name, normalized_name, industry)
        values (${`dk-${suffix}`}, ${name}, ${name}, 'derm') returning id
      `;
      await db.owner`
        insert into company_observations (company_id, attempt_id, run_date, status, track)
        values (${company!.id}, ${attemptId}, ${runDate}::date, 'active', 'new')
      `;
      for (const [type, url] of channels) {
        const [ch] = await db.owner<{ id: string }[]>`
          insert into channels (company_id, type, url)
          values (${company!.id}, ${type}::channel_type, ${url}) returning id
        `;
        ids[`${name}:${type}`] = ch!.id;
      }
      return company!.id;
    };

    await seed("활발한의원", [["official_blog", "https://blog.naver.com/active"]]);
    await seed("휴면의원", [["official_blog", "https://blog.naver.com/dormant"]]);
    await seed("인스타만의원", [["official_sns", "https://instagram.com/onlyinsta"]]);
    await seed("채널없는의원", []);

    const { http } = fakeHttp((url) => {
      if (url.endsWith("/robots.txt")) return { body: "User-agent: *\nAllow: /\n" };
      if (url.includes("active")) {
        return { body: RSS(["Mon, 27 Jul 2026 10:00:00 +0900", "Mon, 20 Jul 2026 10:00:00 +0900"]) };
      }
      if (url.includes("dormant")) return { body: RSS(["Mon, 06 Jan 2026 10:00:00 +0900"]) };
      return { body: "" };
    });

    const ctx: StageContext = {
      sql: db.owner, runId, attemptId, runDate, settings: {}, logger: nullLogger, adapters: [],
      http, robots: new RobotsGate({ client: http, userAgentToken: "leadopsbot", logger: nullLogger }),
    };
    await channelStage.run(ctx, {});
  }, 60_000);

  const obsOf = async (key: string) => {
    const [row] = await db.owner<Array<{
      is_active: boolean | null; last_post_at: string | null; posts_60d: number | null;
      analyzable: boolean; unavailable_reason: string | null; content_mix: Record<string, number>;
      feed_saturated: boolean;
    }>>`
      select is_active, last_post_at, posts_60d, analyzable, unavailable_reason, content_mix, feed_saturated
      from channel_observations where channel_id = ${ids[key]!} and attempt_id = ${attemptId}
    `;
    return row!;
  };

  it("최근 발행이 있으면 활성으로 기록한다", async () => {
    const row = await obsOf("활발한의원:official_blog");
    expect(row.analyzable).toBe(true);
    expect(row.is_active).toBe(true);
    expect(row.posts_60d).toBe(2);
    expect(row.content_mix["event"]).toBe(2);
  });

  it("❗ 오래 쉰 채널을 비활성으로 기록한다 (취약점 신호)", async () => {
    const row = await obsOf("휴면의원:official_blog");
    expect(row.is_active).toBe(false);
    expect(row.posts_60d).toBe(0);
    expect(row.last_post_at).not.toBeNull();
  });

  it("❗ 공개 피드가 없는 SNS 는 사유와 함께 unavailable 이다", async () => {
    const row = await obsOf("인스타만의원:official_sns");
    expect(row.analyzable).toBe(false);
    expect(row.unavailable_reason).toBe("instagram_no_public_feed");
    expect(row.is_active).toBeNull();
  });

  it("공식 채널이 없는 업체를 조용히 넘기지 않는다", async () => {
    const { http } = fakeHttp(() => ({ body: "" }));
    const ctx: StageContext = {
      sql: db.owner, runId, attemptId, runDate, settings: {}, logger: nullLogger, adapters: [],
      http, robots: new RobotsGate({ client: http, userAgentToken: "leadopsbot", logger: nullLogger }),
    };
    const result = await channelStage.run(ctx, {});
    expect(result.skipped["no_official_channel"]).toBe(1);
  });

  it("멱등하다 — 다시 돌려도 관측이 늘지 않는다", async () => {
    const [row] = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from channel_observations where attempt_id = ${attemptId}
    `;
    expect(row!.n).toBe("3");
  });

  it("HttpClient 없이 실행하면 configuration_error 다", async () => {
    const ctx: StageContext = {
      sql: db.owner, runId, attemptId, runDate, settings: {}, logger: nullLogger, adapters: [],
    };
    await expect(channelStage.run(ctx, {})).rejects.toThrow(/HttpClient/);
  });
});

// ────────────────────────────────────────────────────────────── 검색 · ORS

describe("search_analyze — ORS", () => {
  const settings = { quota: { naver_daily_cap: 20000, data_go_kr_daily_cap: 9000, youtube_daily_units: 9000 } };

  async function seedOfficial(attemptId: string, runDate: string, name: string): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [company] = await db.owner<{ id: string }[]>`
      insert into companies (dedupe_key, name, normalized_name, industry, region_sigungu)
      values (${`dk-${suffix}`}, ${name}, ${name}, 'derm', '강남구') returning id
    `;
    await db.owner`
      insert into company_observations (company_id, attempt_id, run_date, status, track)
      values (${company!.id}, ${attemptId}, ${runDate}::date, 'active', 'new')
    `;
    const [site] = await db.owner<{ id: string }[]>`
      insert into websites (company_id, canonical_url, domain)
      values (${company!.id}, ${`https://${suffix}.kr`}, ${`${suffix}.kr`}) returning id
    `;
    await db.owner`
      insert into website_observations (website_id, attempt_id, run_date, official_status, official_score)
      values (${site!.id}, ${attemptId}, ${runDate}::date, 'confirmed', 80)
    `;
    return company!.id;
  }

  it("❗ 검색 어댑터가 없으면 실패가 아니라 건너뛴다 (축소 파이프라인)", async () => {
    // 이 블록은 관측 테이블에 insert 하지 않아(QuotaGuard·runs 만) 파티션 창과 무관 — 고정 날짜가 안전하다.
    const { runId, attemptId, runDate } = await createRun(db, "2026-10-20");
    const ctx: StageContext = {
      sql: db.owner, runId, attemptId, runDate, settings, logger: nullLogger, adapters: [],
    };
    const result = await searchStage.run(ctx, {});
    expect(result.skipped["ors_disabled"]).toBe(1);
    expect(result.note).toContain("FEATURE_ORS=off");
  });

  it("업체별 4채널을 집계하고 키워드를 저장한다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(2));
    const companyId = await seedOfficial(attemptId, runDate, "라온피부과의원");
    const adapter = new MockSearchAdapter();

    const ctx: StageContext = {
      sql: db.owner, runId, attemptId, runDate, settings, logger: nullLogger, adapters: [], search: adapter,
    };
    const result = await searchStage.run(ctx, {});
    expect(result.passed).toBe(1);

    const [keywords] = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from company_keywords where company_id = ${companyId}
    `;
    // 브랜드 1 + 비브랜드 3
    expect(keywords!.n).toBe("4");

    const rows = await db.owner<Array<{ provider: string; keyword_kind: string; denominator: number }>>`
      select provider, keyword_kind, denominator from search_aggregates
      where attempt_id = ${attemptId} and company_id = ${companyId}
    `;
    // 키워드 4개 × 채널 4개
    expect(rows.length).toBe(16);
    expect(new Set(rows.map((r) => r.provider))).toEqual(
      new Set(["blog", "cafearticle", "webkr", "news"]),
    );
    expect(new Set(rows.map((r) => r.keyword_kind))).toEqual(new Set(["brand", "nonbrand"]));
  });

  it("❗ 브랜드와 비브랜드를 분리해 저장한다 (합산 금지)", async () => {
    const [row] = await db.owner<Array<{ n: string }>>`
      select count(distinct keyword_kind)::text as n from search_aggregates
    `;
    expect(Number(row!.n)).toBe(2);
  });

  it("❗ 결과가 0건인 채널은 ors 가 null 이다 (0 이 아니다)", async () => {
    const rows = await db.owner<Array<{ denominator: number; ors: string | null }>>`
      select denominator, ors from search_aggregates where denominator = 0
    `;
    // 목업은 일부 키워드에서 의도적으로 0건을 돌려준다.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.ors).toBeNull();
  });

  it("검색 결과를 search_hits 에 중복 없이 남긴다", async () => {
    const dup = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from (
        select attempt_id, company_id, keyword, url_hash from search_hits
        group by 1,2,3,4 having count(*) > 1
      ) d
    `;
    expect(dup[0]!.n).toBe("0");
  });

  it("분류기 버전을 남긴다 (R2-14 — 음성 결과 사후 감사)", async () => {
    const [row] = await db.owner<Array<{ classifier_version: string }>>`
      select classifier_version from search_aggregates limit 1
    `;
    expect(row!.classifier_version).toMatch(/^ors-v\d/);
  });

  it("❗ 쿼터가 소진되면 그 자리에서 멈춘다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(3));
    await seedOfficial(attemptId, runDate, "쿼터소진의원");
    const adapter = new MockSearchAdapter();
    // 쿼터는 provider 단위 · 하루 단위다. 앞 테스트가 이미 쓴 몫을 비워 의도를 분명히 한다.
    await db.owner`delete from cost_ledger where provider = 'naver_search'`;

    const ctx: StageContext = {
      sql: db.owner, runId, attemptId, runDate,
      // 호출 2회분만 허용한다.
      settings: { quota: { naver_daily_cap: 2, data_go_kr_daily_cap: 1, youtube_daily_units: 1 } },
      logger: nullLogger, adapters: [], search: adapter,
    };
    const result = await searchStage.run(ctx, {});

    expect(result.skipped["quota_exhausted"]).toBe(1);
    expect(result.note).toContain("쿼터 소진");
    expect(adapter.callCount).toBe(2);
  });

  it("쿼터 선점이 cost_ledger 에 남는다", async () => {
    const [row] = await db.owner<Array<{ n: string; qty: string }>>`
      select count(*)::text as n, coalesce(sum(qty), 0)::text as qty
      from cost_ledger where provider = 'naver_search'
    `;
    expect(Number(row!.n)).toBeGreaterThan(0);
    expect(Number(row!.qty)).toBe(Number(row!.n));
  });
});
