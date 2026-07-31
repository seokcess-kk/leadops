import { nullLogger } from "@leadops/core";
import { createRun, createTestDb, type TestDb } from "@leadops/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { competitorAnalyzeStage, competitorSelectStage } from "./competitor";
import { scoreStage } from "./score";
import { recommendStage, shortlistStage } from "./shortlist";
import type { StageContext } from "./types";

/**
 * Phase 5 통합 — 경쟁사 · 3축 점수 · 추천 · 검수 후보.
 *
 * ❗ 워커 E2E 는 목업 홈페이지가 전부 도달 불가라 "게이트 통과 0건" 만 증명한다.
 *    여기서는 **실제로 리드가 만들어지는 경로**를 확인한다 — 그것이 제품의 산출물이다.
 */

let db: TestDb;

/**
 * 오늘(UTC) 기준 상대 날짜. 파티션 창(현재 달 ~ +2개월)은 테스트 실행 시각 기준이므로
 * 관측을 남기는 테스트의 고정 절대 날짜는 달력에 따라 창 밖으로 밀려난다 —
 * packages/db/src/fixtures.ts 의 `createRun` 동적 기본값과 같은 이유다.
 */
function relativeDate(daysFromToday: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

const SETTINGS = {
  scoring: {
    mode: "ors_disabled",
    axis_problem_min: 15,
    axis_propensity_min: 10,
    axis_confidence_min: 9,
    total_min_normalized: 60,
    rule_version: "v3-test",
  },
  targets: { review_max: 100, final_max: 50, industry_share_max: 0.6 },
};

const ctxFor = (
  runId: string,
  attemptId: string,
  runDate: string,
  settings: Record<string, unknown> = SETTINGS,
): StageContext => ({
  sql: db.owner,
  runId,
  attemptId,
  runDate,
  settings,
  logger: nullLogger,
  adapters: [],
});

interface SeedOptions {
  name: string;
  industry?: string;
  sigungu?: string;
  dong?: string;
  sizeTier?: string;
  groupId?: string | null;
  /** 홈페이지 판정. 지정하지 않으면 관측을 만들지 않는다(=미분석). */
  official?: "confirmed" | "likely" | "uncertain" | "unavailable" | null;
  /** 채널 발행량. null 이면 채널을 만들지 않는다. */
  posts?: { p60: number; p120: number; lastPostAt: string } | null;
  channelTypes?: string[];
  contactKinds?: string[];
  excluded?: boolean;
  doNotContact?: boolean;
}

/**
 * 업체 하나를 원하는 관측 상태로 만든다.
 *
 * ❗ `dong` 을 테스트마다 다르게 주는 것이 중요하다. 테스트 DB 는 파일 단위로 공유되므로,
 *    모두 같은 지역에 두면 이전 테스트의 업체가 경쟁사 후보로 섞여 들어와 유사도 동점이
 *    되고, 그러면 어떤 업체가 뽑히는지가 uuid 순서에 좌우된다.
 */
async function seed(attemptId: string, runDate: string, o: SeedOptions): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const [company] = await db.owner<{ id: string }[]>`
    insert into companies (
      dedupe_key, name, normalized_name, industry, region_sido, region_sigungu, region_dong,
      size_tier, group_id, excluded_reason, do_not_contact, last_scanned_at
    ) values (
      ${`dk-${suffix}`}, ${o.name}, ${o.name}, ${o.industry ?? "derm"},
      '서울특별시', ${o.sigungu ?? "강남구"}, ${o.dong ?? "역삼동"},
      ${o.sizeTier ?? "small"}, ${o.groupId ?? null},
      ${o.excluded ? "closed: 폐업" : null}, ${o.doNotContact ?? false}, now()
    )
    returning id
  `;
  const companyId = company!.id;

  await db.owner`
    insert into company_observations (company_id, attempt_id, run_date, status, track)
    values (${companyId}, ${attemptId}, ${runDate}::date, 'active', 'new')
    on conflict do nothing
  `;

  if (o.official !== null && o.official !== undefined) {
    const [site] = await db.owner<{ id: string }[]>`
      insert into websites (company_id, canonical_url, domain)
      values (${companyId}, ${`https://${suffix}.kr`}, ${`${suffix}.kr`}) returning id
    `;
    await db.owner`
      insert into website_observations (
        website_id, attempt_id, run_date, official_status, official_score, signals, has_noindex
      )
      values (${site!.id}, ${attemptId}, ${runDate}::date, ${o.official}::official_status, 80,
              ${db.owner.json({ https: true, nameInTitle: true })}, false)
    `;
    for (const kind of o.contactKinds ?? []) {
      await db.owner`
        insert into contact_pages (website_id, attempt_id, url, page_kind, link_text, confidence)
        values (${site!.id}, ${attemptId}, ${`https://${suffix}.kr/${kind}`}, ${kind}, ${kind}, 0.8)
      `;
    }
  }

  if (o.posts !== null && o.posts !== undefined) {
    for (const type of o.channelTypes ?? ["official_blog"]) {
      const [ch] = await db.owner<{ id: string }[]>`
        insert into channels (company_id, type, url)
        values (${companyId}, ${type}::channel_type, ${`https://blog.example/${suffix}/${type}`})
        returning id
      `;
      await db.owner`
        insert into channel_observations (
          channel_id, attempt_id, run_date, is_active, last_post_at, posts_60d, posts_120d, analyzable, content_mix
        ) values (
          ${ch!.id}, ${attemptId}, ${runDate}::date, ${o.posts.p60 > 0}, ${o.posts.lastPostAt}::date,
          ${o.posts.p60}, ${o.posts.p120}, true, '{}'::jsonb
        )
      `;
    }
  }

  return companyId;
}

/** 게이트를 통과할 대상 업체 (콘텐츠가 죽어 있고 접점은 살아 있다). */
const TARGET: SeedOptions = {
  name: "라온피부과의원",
  official: "confirmed",
  posts: { p60: 0, p120: 0, lastPostAt: "2026-01-05" },
  contactKinds: ["contact", "partnership"],
};

/** 활발한 경쟁사 (분석 완료 + 발행 많음). */
const ACTIVE_PEER = (name: string): SeedOptions => ({
  name,
  official: "confirmed",
  posts: { p60: 15, p120: 30, lastPostAt: "2026-07-28" },
  channelTypes: ["official_blog", "official_video"],
});

beforeAll(async () => {
  db = await createTestDb("phase5");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

// ────────────────────────────────────────────────────────── 경쟁사 선정

describe("competitor_select — 검색이 아니라 매칭으로 고른다", () => {
  it("업종·지역·규모가 가까운 업체를 고른다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(1));
    const dong = "선정동";
    const target = await seed(attemptId, runDate, { ...TARGET, dong });
    await seed(attemptId, runDate, { name: "가까운피부과의원", sigungu: "강남구", dong });
    await seed(attemptId, runDate, { name: "먼피부과의원", sigungu: "부산진구", dong: "부전동" });
    await seed(attemptId, runDate, { name: "다른업종치과의원", industry: "dental", dong });

    await competitorSelectStage.run(ctxFor(runId, attemptId, runDate), {});

    const peers = await db.owner<Array<{ competitor_name: string; rank: number; similarity: Record<string, unknown> }>>`
      select competitor_name, rank, similarity from competitors
      where attempt_id = ${attemptId} and company_id = ${target} order by rank
    `;
    expect(peers.length).toBeGreaterThan(0);
    // 다른 업종은 후보가 아니다.
    expect(peers.map((p) => p.competitor_name)).not.toContain("다른업종치과의원");
    // 같은 동이 1순위다.
    expect(peers[0]!.competitor_name).toBe("가까운피부과의원");
  });

  it("❗ 같은 네트워크(group_id)는 경쟁사가 아니다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(2));
    const [group] = await db.owner<{ id: string }[]>`
      insert into company_groups (group_key, kind, display_name)
      values (${`g-${Math.random()}`}, 'corporation', '같은법인') returning id
    `;
    const dong = "법인동";
    const target = await seed(attemptId, runDate, { ...TARGET, groupId: group!.id, dong });
    await seed(attemptId, runDate, { name: "같은법인2호점의원", groupId: group!.id, dong });
    await seed(attemptId, runDate, { name: "남의피부과의원", dong });

    await competitorSelectStage.run(ctxFor(runId, attemptId, runDate), {});

    const names = await db.owner<Array<{ competitor_name: string }>>`
      select competitor_name from competitors where attempt_id = ${attemptId} and company_id = ${target}
    `;
    expect(names.map((n) => n.competitor_name)).not.toContain("같은법인2호점의원");
  });

  it("제외된 업체·수신거부 업체는 경쟁사 후보가 아니다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(3));
    const dong = "제외동";
    const target = await seed(attemptId, runDate, { ...TARGET, dong });
    await seed(attemptId, runDate, { name: "폐업피부과의원", excluded: true, dong });
    await seed(attemptId, runDate, { name: "수신거부피부과의원", doNotContact: true, dong });
    await seed(attemptId, runDate, { name: "정상피부과의원", dong });

    await competitorSelectStage.run(ctxFor(runId, attemptId, runDate), {});
    const names = (
      await db.owner<Array<{ competitor_name: string }>>`
        select competitor_name from competitors where attempt_id = ${attemptId} and company_id = ${target}
      `
    ).map((n) => n.competitor_name);
    expect(names).toContain("정상피부과의원");
    expect(names).not.toContain("폐업피부과의원");
    expect(names).not.toContain("수신거부피부과의원");
  });

  it("멱등하다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(4));
    await seed(attemptId, runDate, { ...TARGET, dong: "멱등동" });
    await seed(attemptId, runDate, { name: "peer1피부과의원", dong: "멱등동" });
    const ctx = ctxFor(runId, attemptId, runDate);
    await competitorSelectStage.run(ctx, {});
    const [before] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from competitors where attempt_id = ${attemptId}
    `;
    await competitorSelectStage.run(ctx, {});
    const [after] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from competitors where attempt_id = ${attemptId}
    `;
    expect(after!.n).toBe(before!.n);
  });
});

// ────────────────────────────────────────────────────────── 경쟁사 지표

describe("competitor_analyze — 분석되지 않은 경쟁사는 무효다", () => {
  it("❗ 미분석 경쟁사를 0 으로 채우지 않고 is_valid=false 로 둔다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(5));
    const dong = "미분석동";
    const target = await seed(attemptId, runDate, { ...TARGET, dong });
    await seed(attemptId, runDate, { name: "미분석피부과의원", official: null, posts: null, dong });
    const ctx = ctxFor(runId, attemptId, runDate);
    await competitorSelectStage.run(ctx, {});
    await competitorAnalyzeStage.run(ctx, {});

    const [row] = await db.owner<Array<{ is_valid: boolean; raw: Record<string, unknown> }>>`
      select k.is_valid, m.raw from competitors k
      join competitor_metrics m on m.competitor_id = k.id
      where k.attempt_id = ${attemptId} and k.company_id = ${target}
        and k.competitor_name = '미분석피부과의원'
    `;
    expect(row!.is_valid).toBe(false);
    expect(row!.raw["invalid"]).toBe("not_analyzed");
  });

  it("분석된 경쟁사는 지표와 함께 유효해진다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(6));
    const dong = "활발동";
    const target = await seed(attemptId, runDate, { ...TARGET, dong });
    await seed(attemptId, runDate, { ...ACTIVE_PEER("활발한피부과의원"), dong });
    const ctx = ctxFor(runId, attemptId, runDate);
    await competitorSelectStage.run(ctx, {});
    await competitorAnalyzeStage.run(ctx, {});

    const [row] = await db.owner<Array<{ is_valid: boolean; recency_60d: number; diversity: number; channel_activity: string }>>`
      select k.is_valid, m.recency_60d, m.diversity, m.channel_activity::text as channel_activity
      from competitors k join competitor_metrics m on m.competitor_id = k.id
      where k.attempt_id = ${attemptId} and k.company_id = ${target} and k.competitor_name = '활발한피부과의원'
    `;
    expect(row!.is_valid).toBe(true);
    expect(row!.recency_60d).toBe(30); // 채널 2개 × 15
    expect(row!.diversity).toBe(2);
    expect(Number(row!.channel_activity)).toBe(60);
  });
});

// ────────────────────────────────────────────────────────── 점수

describe("score — 3축 점수와 게이트", () => {
  let runId: string;
  let attemptId: string;
  let runDate: string;
  let target: string;

  beforeAll(async () => {
    const run = await createRun(db, relativeDate(7));
    runId = run.runId;
    attemptId = run.attemptId;
    runDate = run.runDate;
    const dong = "채점동";
    target = await seed(attemptId, runDate, { ...TARGET, dong });
    await seed(attemptId, runDate, { ...ACTIVE_PEER("경쟁사A피부과의원"), dong });
    await seed(attemptId, runDate, { ...ACTIVE_PEER("경쟁사B피부과의원"), dong });
    await seed(attemptId, runDate, { ...ACTIVE_PEER("경쟁사C피부과의원"), dong });

    const ctx = ctxFor(runId, attemptId, runDate);
    await competitorSelectStage.run(ctx, {});
    await competitorAnalyzeStage.run(ctx, {});
    await scoreStage.run(ctx, {});
  }, 120_000);

  it("❗ 조건을 갖춘 업체가 게이트를 통과한다", async () => {
    const [row] = await db.owner<Array<{
      gate_passed: boolean; gate_reason: string | null; total: string;
      axis_problem: string; axis_propensity: string; axis_confidence: string;
      competitor_gap_available: boolean; ors_scored: boolean; rule_version: string;
    }>>`
      select gate_passed, gate_reason, total::text, axis_problem::text, axis_propensity::text,
             axis_confidence::text, competitor_gap_available, ors_scored, rule_version
      from scores where attempt_id = ${attemptId} and company_id = ${target}
    `;
    expect(row!.gate_reason).toBeNull();
    expect(row!.gate_passed).toBe(true);
    expect(row!.competitor_gap_available).toBe(true);
    expect(row!.ors_scored).toBe(false);
    expect(row!.rule_version).toBe("v3-test");
    expect(Number(row!.axis_problem)).toBeGreaterThanOrEqual(15);
    expect(Number(row!.axis_propensity)).toBeGreaterThanOrEqual(10);
    expect(Number(row!.axis_confidence)).toBeGreaterThanOrEqual(9);
  });

  it("취약점과 근거가 저장된다", async () => {
    const [row] = await db.owner<Array<{ weaknesses: Array<{ severity: string; kind: string }>; breakdown: Record<string, unknown> }>>`
      select weaknesses, breakdown from scores where attempt_id = ${attemptId} and company_id = ${target}
    `;
    expect(row!.weaknesses.some((w) => w.severity === "strong")).toBe(true);
    expect(row!.breakdown["problem"]).toBeDefined();
    expect(row!.breakdown["normalized"]).toBeDefined();
  });

  it("❗ 참조한 관측을 score_inputs 에 고정한다 (R2-23)", async () => {
    const kinds = await db.owner<Array<{ input_kind: string; n: string }>>`
      select si.input_kind, count(*)::text as n
      from score_inputs si join scores s on s.id = si.score_id
      where s.attempt_id = ${attemptId} and s.company_id = ${target}
      group by si.input_kind order by si.input_kind
    `;
    const byKind = new Map(kinds.map((k) => [k.input_kind, Number(k.n)]));
    expect(byKind.get("website_obs")).toBe(1);
    expect(byKind.get("channel_obs")).toBe(1);
    expect(byKind.get("competitor")).toBeGreaterThanOrEqual(2);
  });

  it("❗ 다시 채점해도 같은 점수가 나온다 (재현성)", async () => {
    const [before] = await db.owner<{ total: string }[]>`
      select total::text from scores where attempt_id = ${attemptId} and company_id = ${target}
    `;
    await scoreStage.run(ctxFor(runId, attemptId, runDate), {});
    const [after] = await db.owner<{ total: string; n?: string }[]>`
      select total::text from scores where attempt_id = ${attemptId} and company_id = ${target}
    `;
    expect(after!.total).toBe(before!.total);

    const [count] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from scores where attempt_id = ${attemptId} and company_id = ${target}
    `;
    expect(count!.n).toBe("1");
  });

  it("홈페이지 관측이 없는 업체는 채점 대상이 아니다", async () => {
    const run = await createRun(db, relativeDate(8));
    await seed(run.attemptId, run.runDate, { name: "홈페이지없는의원", official: null, posts: null, dong: "무홈페이지동" });
    const result = await scoreStage.run(ctxFor(run.runId, run.attemptId, run.runDate), {});
    expect(result.skipped["no_website_observation"]).toBe(1);
    const [row] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from scores where attempt_id = ${run.attemptId}
    `;
    expect(row!.n).toBe("0");
  });
});

// ────────────────────────────────────────────────────────── 추천 · 검수 후보

describe("recommend · shortlist", () => {
  let runId: string;
  let attemptId: string;
  let runDate: string;

  beforeAll(async () => {
    const run = await createRun(db, relativeDate(9));
    runId = run.runId;
    attemptId = run.attemptId;
    runDate = run.runDate;
    const dong = "추천동";
    await seed(attemptId, runDate, { ...TARGET, name: "1순위피부과의원", dong });
    await seed(attemptId, runDate, { ...TARGET, name: "2순위피부과의원", contactKinds: ["contact"], dong });
    await seed(attemptId, runDate, { ...ACTIVE_PEER("경쟁사A피부과의원"), dong });
    await seed(attemptId, runDate, { ...ACTIVE_PEER("경쟁사B피부과의원"), dong });
    await seed(attemptId, runDate, { ...ACTIVE_PEER("경쟁사C피부과의원"), dong });

    const ctx = ctxFor(runId, attemptId, runDate);
    await competitorSelectStage.run(ctx, {});
    await competitorAnalyzeStage.run(ctx, {});
    await scoreStage.run(ctx, {});
    await recommendStage.run(ctx, {});
    await shortlistStage.run(ctx, {});
  }, 120_000);

  it("게이트를 통과한 업체에 추천이 붙는다", async () => {
    const rows = await db.owner<Array<{ primary_service: string; rationale: string; rationale_source: string }>>`
      select r.primary_service, r.rationale, r.rationale_source
      from recommendations r join scores s on s.id = r.score_id
      where s.attempt_id = ${attemptId}
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.rationale_source).toBe("rule");
    expect(rows[0]!.rationale.length).toBeGreaterThan(10);
  });

  it("❗ 게이트를 통과하지 못한 업체에는 추천이 없다", async () => {
    const [row] = await db.owner<{ n: string }[]>`
      select count(*)::text as n
      from recommendations r join scores s on s.id = r.score_id
      where s.attempt_id = ${attemptId} and s.gate_passed = false
    `;
    expect(row!.n).toBe("0");
  });

  it("검수 후보가 총점 순으로 만들어진다", async () => {
    const rows = await db.owner<Array<{ rank: number; total: string; name: string }>>`
      select ri.rank, s.total::text as total, c.name
      from review_items ri
      join scores s on s.id = ri.score_id
      join companies c on c.id = ri.company_id
      where ri.attempt_id = ${attemptId}
      order by ri.rank
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.rank).toBe(1);
    for (let i = 1; i < rows.length; i++) {
      expect(Number(rows[i - 1]!.total)).toBeGreaterThanOrEqual(Number(rows[i]!.total));
    }
  });

  it("❗ 업종 쿼터가 검수 후보에도 적용된다", async () => {
    const run = await createRun(db, relativeDate(10));
    const dong = "쿼터동";
    await seed(run.attemptId, run.runDate, { ...TARGET, name: "쿼터1피부과의원", dong });
    await seed(run.attemptId, run.runDate, { ...TARGET, name: "쿼터2피부과의원", dong });
    await seed(run.attemptId, run.runDate, { ...ACTIVE_PEER("쿼터경쟁A피부과의원"), dong });
    await seed(run.attemptId, run.runDate, { ...ACTIVE_PEER("쿼터경쟁B피부과의원"), dong });

    // 업종당 1건만 허용하는 설정 (review_max 3 × share 0.5 = 1)
    const tight = { ...SETTINGS, targets: { review_max: 3, final_max: 2, industry_share_max: 0.5 } };
    const ctx = ctxFor(run.runId, run.attemptId, run.runDate, tight);
    await competitorSelectStage.run(ctx, {});
    await competitorAnalyzeStage.run(ctx, {});
    await scoreStage.run(ctx, {});
    const result = await shortlistStage.run(ctx, {});

    expect(result.passed).toBe(1);
    expect(result.skipped["industry_quota:derm"]).toBeGreaterThanOrEqual(1);
    expect(result.note).toContain("업종당 1");
  });

  it("멱등하다 — 다시 돌려도 후보가 늘지 않는다", async () => {
    const [before] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from review_items where attempt_id = ${attemptId}
    `;
    await shortlistStage.run(ctxFor(runId, attemptId, runDate), {});
    const [after] = await db.owner<{ n: string }[]>`
      select count(*)::text as n from review_items where attempt_id = ${attemptId}
    `;
    expect(after!.n).toBe(before!.n);
  });

  it("설정이 없으면 통과가 아니라 에러다", async () => {
    await expect(shortlistStage.run(ctxFor(runId, attemptId, runDate, {}), {})).rejects.toThrow(/targets/);
    await expect(scoreStage.run(ctxFor(runId, attemptId, runDate, {}), {})).rejects.toThrow(/scoring/);
  });
});
