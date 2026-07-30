import { describe, expect, it } from "vitest";
import type { ChannelFact, CompetitorFact, OrsFact, ScoreFacts } from "./facts";
import { gradeWeaknesses, tally, weaknessGatePassed } from "./weakness";

/**
 * 취약점 등급 (설계서 부록 A.4).
 *
 * ❗ 가장 중요한 성질: **약한 기술 SEO 만으로는 리드가 되지 않는다.**
 *    title 이 없다는 이유로 영업 전화를 걸 수는 없다.
 */

const NOW = new Date("2026-08-01T00:00:00Z");

const channel = (over: Partial<ChannelFact> = {}): ChannelFact => ({
  type: "official_blog",
  analyzable: true,
  posts60d: 5,
  posts120d: 12,
  lastPostAt: "2026-07-25",
  contentMix: {},
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

const facts = (over: Partial<ScoreFacts> = {}): ScoreFacts => ({
  companyId: "c1",
  industry: "derm",
  regionSigungu: "강남구",
  sizeTier: "small",
  doNotContact: false,
  officialStatus: "confirmed",
  contactPageKinds: ["contact"],
  channels: [channel(), channel({ type: "official_video" }), channel({ type: "official_sns" })],
  ors: [],
  orsScored: false,
  competitors: [peer(), peer()],
  localCompetitionCount: 10,
  analysisCompleteness: 1,
  now: NOW,
  ...over,
});

describe("strong 등급", () => {
  it("공식 채널이 전혀 없으면 strong 이다", () => {
    const w = gradeWeaknesses(facts({ channels: [] }));
    expect(w.find((x) => x.kind === "no_official_channel")?.severity).toBe("strong");
  });

  it("120일 무발행은 strong 이다", () => {
    const dead = channel({ posts60d: 0, posts120d: 0, lastPostAt: "2026-01-01" });
    const w = gradeWeaknesses(facts({ channels: [dead] }));
    expect(w.find((x) => x.kind === "dormant_120d")?.severity).toBe("strong");
  });

  it("❗ 채널 부재와 무발행을 동시에 세지 않는다", () => {
    const w = gradeWeaknesses(facts({ channels: [] }));
    expect(w.filter((x) => x.severity === "strong").length).toBe(1);
  });

  it("비브랜드 키워드 다수에서 회수 0건이면 strong 이다", () => {
    const ors: OrsFact[] = [
      { keyword: "강남 피부과", keywordKind: "nonbrand", provider: "blog", denominator: 30, officialCount: 0, relatedCount: 0, ors: 0 },
      { keyword: "강남 여드름", keywordKind: "nonbrand", provider: "blog", denominator: 30, officialCount: 0, relatedCount: 0, ors: 0 },
    ];
    const w = gradeWeaknesses(facts({ ors }));
    expect(w.find((x) => x.kind === "no_nonbrand_retrieval")?.severity).toBe("strong");
  });
});

describe("medium 등급", () => {
  it("60일만 무발행이면 medium 이다 (120일에는 발행이 있었다)", () => {
    const w = gradeWeaknesses(facts({ channels: [channel({ posts60d: 0, posts120d: 6 })] }));
    expect(w.find((x) => x.kind === "dormant_60d")?.severity).toBe("medium");
    expect(w.some((x) => x.kind === "dormant_120d")).toBe(false);
  });

  it("채널 유형이 2종 이하면 medium 이다", () => {
    const w = gradeWeaknesses(facts({ channels: [channel(), channel({ type: "official_video" })] }));
    expect(w.find((x) => x.kind === "low_channel_diversity")?.severity).toBe("medium");
  });

  it("유형이 3종이면 다양성 취약점이 없다", () => {
    expect(gradeWeaknesses(facts()).some((x) => x.kind === "low_channel_diversity")).toBe(false);
  });

  it("최종 발행이 180일 넘게 지났으면 medium 이다", () => {
    const w = gradeWeaknesses(facts({ channels: [channel({ lastPostAt: "2026-01-01" })] }));
    expect(w.find((x) => x.kind === "stale_last_post")?.severity).toBe("medium");
  });
});

describe("clear_gap 등급", () => {
  it("모드 B 에서는 채널 활동량으로 판정한다", () => {
    const w = gradeWeaknesses(
      facts({
        channels: [channel({ posts60d: 1, posts120d: 2 })],
        competitors: [peer({ channelActivity: 40 }), peer({ channelActivity: 40 })],
      }),
    );
    expect(w.find((x) => x.kind === "channel_activity_gap")?.severity).toBe("clear_gap");
  });

  it("ORS 가 배점에 반영되면 ORS 로 판정한다", () => {
    const ors: OrsFact[] = [
      { keyword: "k", keywordKind: "nonbrand", provider: "blog", denominator: 30, officialCount: 1, relatedCount: 1, ors: 0.03 },
    ];
    const w = gradeWeaknesses(facts({ ors, orsScored: true, competitors: [peer({ ors: 0.4 }), peer({ ors: 0.4 })] }));
    expect(w.find((x) => x.kind === "ors_gap")?.severity).toBe("clear_gap");
  });

  it("❗ 유효 경쟁사가 부족하면 격차를 판정하지 않는다", () => {
    const w = gradeWeaknesses(
      facts({ channels: [channel({ posts60d: 0 })], competitors: [peer({ channelActivity: 40 })] }),
    );
    expect(w.some((x) => x.severity === "clear_gap")).toBe(false);
  });

  it("경쟁사 값이 0 이면 격차가 아니다 (아무도 안 하고 있다)", () => {
    const w = gradeWeaknesses(
      facts({
        channels: [channel({ posts60d: 0 })],
        competitors: [peer({ channelActivity: 0 }), peer({ channelActivity: 0 })],
      }),
    );
    expect(w.some((x) => x.severity === "clear_gap")).toBe(false);
  });
});

describe("❗ weak 등급은 게이트에 들어가지 않는다", () => {
  it("기술 SEO 문제를 기록하되 weak 으로 둔다", () => {
    const w = gradeWeaknesses(facts(), { hasTitle: false, https: false, hasNoindex: true });
    expect(w.filter((x) => x.severity === "weak").length).toBe(3);
  });

  it("weak 만 있으면 게이트를 통과하지 못한다", () => {
    const w = gradeWeaknesses(facts(), { hasTitle: false, https: false, hasNoindex: true });
    const t = tally(w);
    expect(t.weak).toBe(3);
    expect(weaknessGatePassed(t)).toBe(false);
  });
});

describe("게이트 규칙", () => {
  it("strong 1개면 통과", () => {
    expect(weaknessGatePassed({ strong: 1, medium: 0, clearGap: 0, weak: 0 })).toBe(true);
  });

  it("medium 2개면 통과", () => {
    expect(weaknessGatePassed({ strong: 0, medium: 2, clearGap: 0, weak: 0 })).toBe(true);
  });

  it("medium 1개만으로는 통과하지 못한다", () => {
    expect(weaknessGatePassed({ strong: 0, medium: 1, clearGap: 0, weak: 0 })).toBe(false);
  });

  it("clear_gap 1개 + medium 1개면 통과", () => {
    expect(weaknessGatePassed({ strong: 0, medium: 1, clearGap: 1, weak: 0 })).toBe(true);
  });

  it("clear_gap 만으로는 통과하지 못한다", () => {
    expect(weaknessGatePassed({ strong: 0, medium: 0, clearGap: 1, weak: 0 })).toBe(false);
  });

  it("아무것도 없으면 통과하지 못한다", () => {
    expect(weaknessGatePassed({ strong: 0, medium: 0, clearGap: 0, weak: 0 })).toBe(false);
  });
});

describe("❗ 관측 실패를 취약점으로 만들지 않는다", () => {
  it("분석 불가 채널만 있으면 무발행 취약점이 없다", () => {
    const w = gradeWeaknesses(
      facts({ channels: [channel({ analyzable: false, posts60d: null, posts120d: null, lastPostAt: null })] }),
    );
    expect(w.some((x) => x.kind === "dormant_60d" || x.kind === "dormant_120d")).toBe(false);
  });

  it("분모가 0 인 ORS 행은 제3자 콘텐츠 판정에 쓰이지 않는다", () => {
    const ors: OrsFact[] = [
      { keyword: "k", keywordKind: "nonbrand", provider: "blog", denominator: 0, officialCount: 0, relatedCount: 0, ors: null },
    ];
    const w = gradeWeaknesses(facts({ ors }));
    expect(w.some((x) => x.kind === "no_thirdparty_content")).toBe(false);
  });
});
