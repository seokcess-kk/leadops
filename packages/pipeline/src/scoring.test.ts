import { describe, expect, it } from "vitest";
import type { ChannelFact, CompetitorFact, OrsFact, ScoreFacts } from "./facts";
import { marketingActivityOf, score, scoringSettingsFrom, type ScoringSettings } from "./scoring";

/**
 * 3축 점수와 게이트 (설계서 부록 A).
 *
 * ❗ 이 테스트가 지키는 것은 두 가지다.
 *    1. **측정하지 못한 것을 0점으로 세지 않는다.** 결측을 0으로 바꾸면 우리 수집 실패가
 *       상대의 취약점이 되고, 그 업체가 리드로 올라간다.
 *    2. **재현성** — 같은 관측이면 같은 점수가 나온다 (Phase 5 완료 기준).
 */

const NOW = new Date("2026-08-01T00:00:00Z");

const MODE_B: ScoringSettings = {
  mode: "ors_disabled",
  axisProblemMin: 15,
  axisPropensityMin: 10,
  axisConfidenceMin: 9,
  totalMinNormalized: 60,
  ruleVersion: "test-v1",
};

const channel = (over: Partial<ChannelFact> = {}): ChannelFact => ({
  type: "official_blog",
  analyzable: true,
  posts60d: 0,
  posts120d: 0,
  lastPostAt: "2026-01-01",
  contentMix: { event: 0, info: 0, review: 0, notice: 0, etc: 0 },
  ...over,
});

const peer = (over: Partial<CompetitorFact> = {}): CompetitorFact => ({
  competitorId: `k-${Math.random()}`,
  isValid: true,
  ors: 0.3,
  recency60d: 10,
  diversity: 3,
  channelActivity: 20,
  ...over,
});

/** 게이트를 통과하는 기준 업체. 각 테스트는 여기서 한 가지만 바꾼다. */
function facts(over: Partial<ScoreFacts> = {}): ScoreFacts {
  return {
    companyId: "c1",
    industry: "derm",
    regionSigungu: "강남구",
    sizeTier: "small",
    doNotContact: false,
    officialStatus: "confirmed",
    contactPageKinds: ["contact", "partnership"],
    channels: [channel()],
    ors: [],
    orsScored: false,
    competitors: [peer(), peer(), peer()],
    localCompetitionCount: 25,
    analysisCompleteness: 1,
    lastScannedAt: "2026-07-31T00:00:00Z",
    now: NOW,
    ...over,
  };
}

describe("설정 파싱", () => {
  it("시드 값을 읽는다", () => {
    const parsed = scoringSettingsFrom({
      scoring: {
        mode: "ors_disabled",
        axis_problem_min: 15,
        axis_propensity_min: 10,
        axis_confidence_min: 9,
        total_min_normalized: 60,
        rule_version: "v3",
      },
    });
    expect(parsed.mode).toBe("ors_disabled");
    expect(parsed.axisProblemMin).toBe(15);
  });

  it("섹션이나 mode 가 없으면 통과가 아니라 에러다", () => {
    expect(() => scoringSettingsFrom({})).toThrow(/scoring/);
    expect(() => scoringSettingsFrom({ scoring: { mode: "wide" } })).toThrow(/mode/);
  });
});

describe("게이트", () => {
  it("기준 업체는 통과한다", () => {
    const r = score(facts(), MODE_B);
    expect(r.gatePassed).toBe(true);
    expect(r.gateReason).toBeUndefined();
  });

  it("❗ do_not_contact 는 어떤 점수보다 우선한다", () => {
    const r = score(facts({ doNotContact: true }), MODE_B);
    expect(r.gatePassed).toBe(false);
    expect(r.gateReason).toContain("do_not_contact");
  });

  it("❗ 공식 홈페이지가 아니면 통과하지 못한다", () => {
    for (const status of ["uncertain", "not_official", "unavailable"] as const) {
      const r = score(facts({ officialStatus: status }), MODE_B);
      expect(r.gatePassed, status).toBe(false);
      expect(r.gateReason).toContain(`official_status=${status}`);
    }
  });

  it("likely 도 공식으로 인정한다", () => {
    expect(score(facts({ officialStatus: "likely" }), MODE_B).gatePassed).toBe(true);
  });

  it("❗ 탈락 사유를 전부 모은다 (첫 사유만 남기지 않는다)", () => {
    const r = score(facts({ doNotContact: true, officialStatus: "not_official", competitors: [] }), MODE_B);
    expect(r.gateReason).toContain("do_not_contact");
    expect(r.gateReason).toContain("official_status");
    expect(r.gateReason).toContain("competitor_gap_unavailable");
  });

  it("총점은 100점 환산으로 판정한다 (모드 B 만점은 67)", () => {
    const r = score(facts(), MODE_B);
    expect(r.totalMax).toBe(67);
    expect(r.normalized).toBeCloseTo((r.total / 67) * 100, 1);
  });
});

describe("❗ 경쟁사 결측 (설계서 A.6)", () => {
  it("유효 경쟁사가 2곳 미만이면 격차를 unavailable 로 둔다", () => {
    const r = score(facts({ competitors: [peer()] }), MODE_B);
    const gap = r.problem.items.find((i) => i.key === "competitor_gap")!;
    expect(gap.unavailable).toBe(true);
    expect(gap.points).toBe(0);
  });

  it("❗ 결측을 0점으로 세지 않는다 — 만점에서도 빠진다 (재정규화 금지)", () => {
    const withPeers = score(facts(), MODE_B);
    const without = score(facts({ competitors: [] }), MODE_B);
    // 격차 12점이 만점에서 빠져야 한다. 0점 처리하면 만점이 그대로 남는다.
    expect(withPeers.problem.max - without.problem.max).toBe(12);
  });

  it("결측이면 게이트를 통과하지 못한다", () => {
    const r = score(facts({ competitors: [peer()] }), MODE_B);
    expect(r.competitorGapAvailable).toBe(false);
    expect(r.gatePassed).toBe(false);
    expect(r.gateReason).toContain("competitor_gap_unavailable(1/2)");
  });

  it("무효 경쟁사는 세지 않는다", () => {
    const r = score(facts({ competitors: [peer(), peer({ isValid: false }), peer({ isValid: false })] }), MODE_B);
    expect(r.competitorGapAvailable).toBe(false);
  });
});

describe("❗ 관측하지 못한 것을 취약점으로 만들지 않는다", () => {
  it("피드를 가져오지 못한 채널은 활동 0 으로 세지 않는다", () => {
    const r = score(
      facts({ channels: [channel({ analyzable: false, posts60d: null, posts120d: null, lastPostAt: null })] }),
      MODE_B,
    );
    const content = r.problem.items.find((i) => i.key === "no_recent_content")!;
    expect(content.unavailable).toBe(true);
    expect(r.weaknesses.some((w) => w.kind === "dormant_60d" || w.kind === "dormant_120d")).toBe(false);
  });

  it("채널이 아예 없는 것은 관측 실패가 아니라 부재다 — 만점을 준다", () => {
    const r = score(facts({ channels: [] }), MODE_B);
    const content = r.problem.items.find((i) => i.key === "no_recent_content")!;
    expect(content.points).toBe(15);
    expect(content.unavailable).toBeUndefined();
    expect(r.weaknesses.some((w) => w.kind === "no_official_channel")).toBe(true);
  });
});

describe("축 1 · 문제 크기", () => {
  it("모드 B 에서는 ORS 항목이 아예 없다", () => {
    const r = score(facts(), MODE_B);
    expect(r.problem.items.some((i) => i.key.startsWith("ors_"))).toBe(false);
    expect(r.orsScored).toBe(false);
  });

  it("발행이 활발하면 콘텐츠 부족 점수가 낮다", () => {
    const active = channel({ posts60d: 12, posts120d: 25, lastPostAt: "2026-07-30" });
    const r = score(facts({ channels: [active] }), MODE_B);
    expect(r.problem.items.find((i) => i.key === "content_60d")!.points).toBe(0);
    expect(r.problem.items.find((i) => i.key === "content_stale")!.points).toBe(0);
  });

  it("경쟁사보다 크게 뒤처지면 격차 점수를 받는다", () => {
    const r = score(facts(), MODE_B);
    expect(r.problem.items.find((i) => i.key === "gap_recency")!.points).toBe(5);
  });

  it("경쟁사와 비슷하면 격차 점수가 없다", () => {
    const r = score(
      facts({ channels: [channel({ posts60d: 10, posts120d: 20, lastPostAt: "2026-07-30" })] }),
      MODE_B,
    );
    expect(r.problem.items.find((i) => i.key === "gap_recency")!.points).toBe(0);
  });
});

describe("축 2 · 구매 가능성 — 예산 신호 상호작용 (A.3)", () => {
  it("❗ 마케팅이 활발한데 격차가 없으면 감점이다 (역방향 신호 방지)", () => {
    // v1 은 마케팅 활발을 무조건 가점했다. 그러면 이미 잘 되는 업체가 좋은 리드가 된다.
    const busy = channel({ posts60d: 10, posts120d: 20, lastPostAt: "2026-07-30" });
    const r = score(facts({ channels: [busy, channel({ type: "official_video", posts60d: 8, posts120d: 16 })] }), MODE_B);
    expect(r.marketingActivity).toBe("high");
    expect(r.tally.clearGap).toBe(0);
    expect(r.propensity.items.find((i) => i.key === "budget_signal")!.points).toBe(2);
  });

  it("마케팅이 활발하고 격차가 있으면 최고점이다", () => {
    // 채널 2개(=high) 지만 발행량이 경쟁사 중앙값의 40% 이하 → clear_gap
    const r = score(
      facts({
        channels: [channel({ posts60d: 1, posts120d: 2 }), channel({ type: "official_video", posts60d: 0, posts120d: 1 })],
        competitors: [peer({ channelActivity: 40 }), peer({ channelActivity: 40 }), peer({ channelActivity: 40 })],
      }),
      MODE_B,
    );
    expect(r.marketingActivity).toBe("high");
    expect(r.tally.clearGap).toBe(1);
    expect(r.propensity.items.find((i) => i.key === "budget_signal")!.points).toBe(10);
  });

  it("마케팅이 약한데 문제가 크면 중간 점수다", () => {
    const r = score(facts({ channels: [] }), MODE_B);
    expect(r.marketingActivity).toBe("low");
    expect(r.propensity.items.find((i) => i.key === "budget_signal")!.points).toBe(6);
  });

  it("이벤트성 콘텐츠 비율이 높으면 마케팅 활발로 본다", () => {
    const eventy = channel({ contentMix: { event: 7, info: 3, review: 0, notice: 0, etc: 0 } });
    expect(marketingActivityOf(facts({ channels: [eventy] }))).toBe("high");
  });

  it("연락처 페이지가 없으면 접점 점수가 0 이다", () => {
    const r = score(facts({ contactPageKinds: [] }), MODE_B);
    expect(r.propensity.items.find((i) => i.key === "contact_exists")!.points).toBe(0);
    expect(r.propensity.items.find((i) => i.key === "contact_kind")!.points).toBe(0);
  });
});

describe("축 3 · 데이터 신뢰도", () => {
  it("confirmed 가 likely 보다 높다", () => {
    const c = score(facts(), MODE_B).confidence.points;
    const l = score(facts({ officialStatus: "likely" }), MODE_B).confidence.points;
    expect(c).toBeGreaterThan(l);
  });

  it("분석 완료 비율이 그대로 반영된다", () => {
    const half = score(facts({ analysisCompleteness: 0.5 }), MODE_B);
    expect(half.confidence.items.find((i) => i.key === "analysis_completeness")!.points).toBe(2.5);
  });

  it("관측이 오래되면 신선도 점수를 잃는다", () => {
    const stale = score(facts({ lastScannedAt: "2026-01-01T00:00:00Z" }), MODE_B);
    const fresh = score(facts(), MODE_B);
    expect(stale.confidence.points).toBeLessThan(fresh.confidence.points);
  });
});

describe("❗ 재현성 (Phase 5 완료 기준)", () => {
  it("같은 관측이면 같은 점수가 나온다", () => {
    const input = facts();
    const a = score(input, MODE_B);
    const b = score(input, MODE_B);
    expect(a.total).toBe(b.total);
    expect(a.problem.points).toBe(b.problem.points);
    expect(a.weaknesses).toEqual(b.weaknesses);
    expect(a.gatePassed).toBe(b.gatePassed);
  });

  it("규칙 버전을 결과에 남긴다", () => {
    expect(score(facts(), MODE_B).ruleVersion).toBe("test-v1");
  });

  it("입력 순서가 결과를 바꾸지 않는다", () => {
    const peers = [peer({ channelActivity: 5 }), peer({ channelActivity: 40 }), peer({ channelActivity: 20 })];
    const a = score(facts({ competitors: peers }), MODE_B);
    const b = score(facts({ competitors: [...peers].reverse() }), MODE_B);
    expect(a.total).toBe(b.total);
  });
});

describe("모드 A (ORS 활성)", () => {
  const MODE_A: ScoringSettings = { ...MODE_B, mode: "ors_enabled", axisProblemMin: 32, totalMinNormalized: 60 };
  const ors = (over: Partial<OrsFact> = {}): OrsFact => ({
    keyword: "강남 피부과",
    keywordKind: "nonbrand",
    provider: "blog",
    denominator: 30,
    officialCount: 0,
    relatedCount: 0,
    ors: 0,
    ...over,
  });

  it("ORS 항목이 추가되고 만점이 커진다", () => {
    const r = score(facts({ ors: [ors()], orsScored: true }), MODE_A);
    expect(r.orsScored).toBe(true);
    expect(r.problem.items.some((i) => i.key === "ors_no_official")).toBe(true);
    expect(r.totalMax).toBeGreaterThan(67);
  });

  it("측정 가능한 ORS 채널이 없으면 unavailable 이다", () => {
    const r = score(facts({ ors: [ors({ denominator: 0, ors: null })], orsScored: true }), MODE_A);
    expect(r.problem.items.find((i) => i.key === "ors_gap")!.unavailable).toBe(true);
  });
});
