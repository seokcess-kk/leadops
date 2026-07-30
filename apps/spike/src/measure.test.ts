import { describe, expect, it } from "vitest";
import {
  computeMetrics,
  decideVerdict,
  parseCsv,
  type GoldsetRow,
  type Metric,
  verdictKey,
  type SystemVerdict,
} from "./measure";
import { spearman, wilson } from "./stats";

/**
 * 측정 하네스 — **숫자가 조용히 틀리는 경로**를 고정한다.
 *
 * 골드셋 측정의 위험은 "실패" 가 아니라 **그럴듯한 잘못된 숫자**다. 라벨을 덜 채운 것이
 * 좋은 성적으로 바뀌거나, 측정하지 못한 항목이 0% 로 보고되면 그 숫자로 배점을 정하게 된다.
 */

// ────────────────────────────────────────────────────────── 통계

describe("wilson", () => {
  it("분모가 0 이면 null 이다 (0% 가 아니다)", () => {
    const p = wilson(0, 0);
    expect(p.point).toBeNull();
    expect(p.low).toBeNull();
    expect(p.high).toBeNull();
  });

  it("❗ 0건 관측에서도 구간이 [0,1] 안에 있다 (Wald 는 벗어난다)", () => {
    const p = wilson(0, 30);
    expect(p.point).toBe(0);
    expect(p.low).toBe(0);
    // rule of three 근사와 비슷한 상한이 나와야 한다 (약 11%).
    expect(p.high).toBeGreaterThan(0.05);
    expect(p.high).toBeLessThan(0.2);
  });

  it("전건 관측에서도 상한이 1 을 넘지 않는다", () => {
    const p = wilson(30, 30);
    expect(p.point).toBe(1);
    // 부동소수 오차로 1 에 아주 못 미칠 수 있다. 넘지 않는 것이 요점이다.
    expect(p.high!).toBeLessThanOrEqual(1);
    expect(p.high).toBeCloseTo(1, 10);
    expect(p.low).toBeGreaterThan(0.8);
    expect(p.low).toBeLessThan(1);
  });

  it("알려진 값과 일치한다 (p=0.5, n=100)", () => {
    const p = wilson(50, 100);
    expect(p.point).toBe(0.5);
    expect(p.low).toBeCloseTo(0.4038, 3);
    expect(p.high).toBeCloseTo(0.5962, 3);
  });

  it("분자가 분모보다 크면 던진다 (조용히 1 로 자르지 않는다)", () => {
    expect(() => wilson(5, 3)).toThrow(/분자가 분모보다/);
    expect(() => wilson(-1, 3)).toThrow(/잘못된 비율/);
    expect(() => wilson(1.5, 3)).toThrow(/잘못된 비율/);
  });
});

describe("spearman", () => {
  it("완전 단조 증가는 ρ=1", () => {
    const r = spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
    expect(r.rho).toBeCloseTo(1, 10);
  });

  it("완전 단조 감소는 ρ=-1", () => {
    const r = spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
    expect(r.rho).toBeCloseTo(-1, 10);
  });

  it("동순위를 평균 순위로 처리한다", () => {
    // x 에 동순위가 있어도 계산이 되고, tie 를 보고한다.
    const r = spearman([1, 1, 2, 3], [1, 2, 3, 4]);
    expect(r.rho).not.toBeNull();
    expect(r.tiedPairs).toBeGreaterThan(0);
  });

  it("❗ 한쪽이 전부 동일하면 0 이 아니라 null 이다 (상관이 정의되지 않는다)", () => {
    const r = spearman([1, 1, 1, 1], [1, 2, 3, 4]);
    expect(r.rho).toBeNull();
    expect(r.high).toBeNull();
  });

  it("n<3 이면 null 이다", () => {
    expect(spearman([1, 2], [1, 2]).rho).toBeNull();
  });

  it("길이가 다르면 던진다", () => {
    expect(() => spearman([1, 2, 3], [1, 2])).toThrow(/길이가 다릅니다/);
  });

  it("CI 상한을 함께 준다 (M7 stop 게이트가 상한을 쓴다)", () => {
    const r = spearman([1, 2, 3, 4, 5, 4, 3, 2], [2, 1, 4, 3, 5, 5, 2, 1]);
    expect(r.high).not.toBeNull();
    expect(r.low).not.toBeNull();
    expect(r.high!).toBeGreaterThan(r.rho!);
    expect(r.low!).toBeLessThan(r.rho!);
  });
});

// ────────────────────────────────────────────────────────── CSV

describe("parseCsv", () => {
  it("BOM 을 제거한다 (Excel 저장본)", () => {
    expect(parseCsv("﻿a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("따옴표 안의 구분자·줄바꿈·이중 따옴표를 처리한다", () => {
    const rows = parseCsv('a,b\n"x,y","he said ""hi""\nnext"');
    expect(rows[1]).toEqual(["x,y", 'he said "hi"\nnext']);
  });

  it("CRLF 를 처리한다", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

// ────────────────────────────────────────────────────── 지표 계산

const blank: GoldsetRow = {
  industry: "derm",
  source: "hira",
  externalId: "x",
  name: "테스트의원",
  homepageUrlHint: "",
  labelOfficialUrl: "",
  labelOfficialStatus: "",
  labelHasBusinessEmail: "",
  labelEmailLocation: "",
  labelEmailIsFreeMail: "",
  labelPerceivedExposure: "",
  labelCompetitorValidity: "",
  labelWorthPitching: "",
  labelRenderMode: "",
};

const row = (id: string, over: Partial<GoldsetRow> = {}): GoldsetRow => ({ ...blank, externalId: id, ...over });

const verdict = (over: Partial<SystemVerdict> = {}): SystemVerdict => ({
  hasWebsite: true,
  officialJudged: null,
  contactPaths: [],
  orsComputed: false,
  validCompetitors: 0,
  shortlisted: false,
  ...over,
});

const metric = (metrics: Metric[], id: string): Metric => {
  const m = metrics.find((x) => x.id === id);
  if (!m) throw new Error(`지표 없음: ${id}`);
  return m;
};

describe("computeMetrics — 미측정 처리", () => {
  it("❗ 라벨이 비어 있으면 0% 가 아니라 '미측정' 이다", () => {
    const rows = [row("a"), row("b")];
    const { metrics } = computeMetrics(rows, new Map());

    for (const id of ["M1", "M3b", "M9", "M14", "M8", "M13"]) {
      const m = metric(metrics, id);
      expect(m.unmeasured, `${id} 는 미측정이어야 한다`).toBeDefined();
      expect(m.proportion?.point ?? null).toBeNull();
    }
  });

  it("❗ 빈 라벨을 'no' 로 읽지 않는다 (라벨링을 덜 한 것이 성적이 되면 안 된다)", () => {
    const rows = [
      row("a", { labelHasBusinessEmail: "yes" }),
      row("b"), // 미라벨
      row("c"), // 미라벨
    ];
    const { metrics } = computeMetrics(rows, new Map());
    const m3b = metric(metrics, "M3b");
    // 분모는 라벨된 1건뿐이어야 한다 — 3건으로 세면 33% 가 되어 stop 게이트가 오작동한다.
    expect(m3b.proportion?.denominator).toBe(1);
    expect(m3b.proportion?.point).toBe(1);
  });
});

describe("computeMetrics — M1 (우리의 발견률 vs 실제 존재율)", () => {
  /**
   * ❗ M1 은 **우리가 URL 을 확보한 비율**이다. 사람이 찾은 비율이 아니다.
   *    미달 대응이 "소스 보강"(설계서 9.1)이므로, 우리가 통제할 수 있는 값을 재야 한다 —
   *    사람이 찾은 비율은 소스를 보강해도 바뀌지 않는 모집단 특성이다.
   */
  const rows = [
    row("a", { labelOfficialStatus: "official" }),
    row("b", { labelOfficialStatus: "official" }),
    row("c", { labelOfficialStatus: "official" }),
    row("d", { labelOfficialStatus: "none" }),
  ];
  const verdicts = new Map<string, SystemVerdict>([
    [verdictKey("hira", "a"), verdict({ hasWebsite: true })],
    [verdictKey("hira", "b"), verdict({ hasWebsite: false })],
    [verdictKey("hira", "c"), verdict({ hasWebsite: false })],
    [verdictKey("hira", "d"), verdict({ hasWebsite: false })],
  ]);

  it("M1 은 우리가 URL 을 확보한 비율이다 (분모: 매칭된 표본 전체)", () => {
    const { metrics } = computeMetrics(rows, verdicts);
    const m1 = metric(metrics, "M1");
    // 1/4 — URL 이 없어 판정조차 못 한 업체가 분모에서 빠지면 발견률의 의미가 사라진다.
    expect(m1.proportion?.numerator).toBe(1);
    expect(m1.proportion?.denominator).toBe(4);
  });

  it("M1-상한 은 사람이 확인한 실제 존재율이다 (우리 발견률의 천장)", () => {
    const { metrics } = computeMetrics(rows, verdicts);
    const ceiling = metric(metrics, "M1-상한");
    expect(ceiling.proportion?.numerator).toBe(3);
    expect(ceiling.proportion?.denominator).toBe(4);
    // ❗ 상한에는 기준이 없다 (실측 지표다). 기준을 붙이면 모집단을 우리 성적으로 오해한다.
    expect(ceiling.threshold).toBeUndefined();
  });
});

describe("computeMetrics — M2 정밀도·재현율", () => {
  const rows = [
    row("tp1", { labelOfficialStatus: "official" }),
    row("tp2", { labelOfficialStatus: "official" }),
    row("fp1", { labelOfficialStatus: "not_official" }),
    row("fn1", { labelOfficialStatus: "official" }),
    row("tn1", { labelOfficialStatus: "none" }),
  ];
  const verdicts = new Map<string, SystemVerdict>([
    [verdictKey("hira", "tp1"), verdict({ officialJudged: true })],
    [verdictKey("hira", "tp2"), verdict({ officialJudged: true })],
    [verdictKey("hira", "fp1"), verdict({ officialJudged: true })],
    [verdictKey("hira", "fn1"), verdict({ officialJudged: false })],
    [verdictKey("hira", "tn1"), verdict({ officialJudged: false })],
  ]);

  it("혼동행렬로 정밀도·재현율을 낸다", () => {
    const { metrics } = computeMetrics(rows, verdicts);
    // TP=2, FP=1 → 정밀도 2/3
    expect(metric(metrics, "M2-정밀도").proportion?.point).toBeCloseTo(2 / 3, 10);
    // TP=2, FN=1 → 재현율 2/3
    expect(metric(metrics, "M2-재현율").proportion?.point).toBeCloseTo(2 / 3, 10);
  });

  it("❗ 우리가 판정하지 못한 행(officialJudged=null)은 분모에서 뺀다", () => {
    // 관측 실패를 "아니라고 판정" 으로 세면 재현율이 우리 수집 실패만큼 낮아진다.
    const withUnjudged = new Map(verdicts);
    withUnjudged.set(verdictKey("hira", "unjudged"), verdict({ officialJudged: null }));
    const { metrics } = computeMetrics(
      [...rows, row("unjudged", { labelOfficialStatus: "official" })],
      withUnjudged,
    );
    // 재현율 분모는 여전히 TP+FN = 3 이어야 한다 (4 가 되면 안 된다).
    expect(metric(metrics, "M2-재현율").proportion?.denominator).toBe(3);
  });

  it("매칭이 없으면 미측정이다 (파이프라인 미실행)", () => {
    const { metrics } = computeMetrics(rows, new Map());
    expect(metric(metrics, "M2-정밀도").unmeasured).toMatch(/파이프라인 미실행/);
  });
});

describe("computeMetrics — M3 연락처 페이지 적중률", () => {
  it("사람이 찾은 경로가 우리 후보에 있으면 적중이다", () => {
    const rows = [
      row("hit", { labelEmailLocation: "/contact" }),
      row("miss", { labelEmailLocation: "/about-us" }),
    ];
    const verdicts = new Map<string, SystemVerdict>([
      [verdictKey("hira", "hit"), verdict({ contactPaths: ["https://a.kr/contact", "https://a.kr/about"] })],
      [verdictKey("hira", "miss"), verdict({ contactPaths: ["https://b.kr/contact"] })],
    ]);
    const { metrics } = computeMetrics(rows, verdicts);
    const m3 = metric(metrics, "M3");
    expect(m3.proportion?.denominator).toBe(2);
    expect(m3.proportion?.numerator).toBe(1);
  });

  it("후보를 제안하지 않은 업체는 분모에서 뺀다 (적중률의 정의)", () => {
    const rows = [row("nocand", { labelEmailLocation: "/contact" })];
    const verdicts = new Map<string, SystemVerdict>([[verdictKey("hira", "nocand"), verdict({ contactPaths: [] })]]);
    const { metrics } = computeMetrics(rows, verdicts);
    expect(metric(metrics, "M3").unmeasured).toBeDefined();
  });

  it("전체 URL 로 적어도 경로로 대조한다", () => {
    const rows = [row("full", { labelEmailLocation: "https://a.kr/contact/" })];
    const verdicts = new Map<string, SystemVerdict>([
      [verdictKey("hira", "full"), verdict({ contactPaths: ["https://a.kr/contact"] })],
    ]);
    const { metrics } = computeMetrics(rows, verdicts);
    expect(metric(metrics, "M3").proportion?.numerator).toBe(1);
  });
});

describe("computeMetrics — M7", () => {
  it("❗ ORS 를 산출하지 못한 업체는 쌍에서 뺀다 (0 으로 채우면 없는 상관을 만든다)", () => {
    const rows = [
      row("a", { labelPerceivedExposure: "5" }),
      row("b", { labelPerceivedExposure: "4" }),
      row("c", { labelPerceivedExposure: "1" }),
      row("d", { labelPerceivedExposure: "2" }),
    ];
    const verdicts = new Map<string, SystemVerdict>([
      [verdictKey("hira", "a"), verdict({ orsComputed: true, validCompetitors: 5 })],
      [verdictKey("hira", "b"), verdict({ orsComputed: true, validCompetitors: 4 })],
      [verdictKey("hira", "c"), verdict({ orsComputed: true, validCompetitors: 1 })],
      [verdictKey("hira", "d"), verdict({ orsComputed: false, validCompetitors: 0 })], // 산출 실패
    ]);
    const { metrics } = computeMetrics(rows, verdicts);
    expect(metric(metrics, "M7").correlation?.n).toBe(3);
  });

  it("쌍이 3개 미만이면 미측정이다", () => {
    const rows = [row("a", { labelPerceivedExposure: "5" })];
    const verdicts = new Map<string, SystemVerdict>([
      [verdictKey("hira", "a"), verdict({ orsComputed: true, validCompetitors: 1 })],
    ]);
    const { metrics } = computeMetrics(rows, verdicts);
    expect(metric(metrics, "M7").unmeasured).toMatch(/n≥3/);
  });

  it("1~5 범위 밖 라벨은 무시한다", () => {
    const rows = [
      row("a", { labelPerceivedExposure: "7" }),
      row("b", { labelPerceivedExposure: "0" }),
      row("c", { labelPerceivedExposure: "상" }),
    ];
    const verdicts = new Map<string, SystemVerdict>(
      rows.map((r) => [verdictKey("hira", r.externalId), verdict({ orsComputed: true, validCompetitors: 1 })]),
    );
    const { metrics } = computeMetrics(rows, verdicts);
    expect(metric(metrics, "M7").unmeasured).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────── 판정

describe("decideVerdict — Phase 0 게이트 (R2-06)", () => {
  const usable = (over: { m3b: number; m7High: number }): Metric[] => [
    { id: "M3b", label: "이메일 공개율", proportion: wilson(Math.round(over.m3b * 100), 100) },
    {
      id: "M7",
      label: "ORS ↔ 체감 노출 ρ",
      correlation: { n: 30, rho: over.m7High - 0.1, low: 0, high: over.m7High, tiedPairs: 0 },
    },
  ];

  it("❗ 'go' 판정은 존재하지 않는다", () => {
    const { verdict } = decideVerdict(usable({ m3b: 0.5, m7High: 0.9 }));
    expect(verdict).toBe("inconclusive");
    expect(["stop", "inconclusive", "미판정"]).toContain(verdict);
  });

  it("M3b < 20% 면 stop", () => {
    const { verdict, reasons } = decideVerdict(usable({ m3b: 0.15, m7High: 0.9 }));
    expect(verdict).toBe("stop");
    expect(reasons.join()).toMatch(/M3b/);
  });

  it("M7 CI 상한 < 0.4 면 stop", () => {
    const { verdict, reasons } = decideVerdict(usable({ m3b: 0.5, m7High: 0.39 }));
    expect(verdict).toBe("stop");
    expect(reasons.join()).toMatch(/M7/);
  });

  it("경계값에서 통과한다 (20% · 0.4 는 stop 이 아니다)", () => {
    expect(decideVerdict(usable({ m3b: 0.2, m7High: 0.4 })).verdict).toBe("inconclusive");
  });

  it("❗ 게이트 입력이 없으면 inconclusive 가 아니라 미판정이다", () => {
    const { verdict, reasons } = decideVerdict([
      { id: "M3b", label: "이메일 공개율", unmeasured: "라벨 없음" },
      { id: "M7", label: "ORS ↔ 체감 노출 ρ", unmeasured: "라벨 없음" },
    ]);
    expect(verdict).toBe("미판정");
    expect(reasons.join()).toMatch(/라벨을 채운 뒤/);
  });

  it("❗ M7 에 주의 표시(unmeasured)가 붙어 있으면 판정에 쓰지 않는다", () => {
    // ORS 가 off 라 대리값을 쓴 경우 — 그 숫자로 stop/inconclusive 를 정할 수 없다.
    const metrics: Metric[] = [
      { id: "M3b", label: "이메일 공개율", proportion: wilson(50, 100) },
      {
        id: "M7",
        label: "ORS ↔ 체감 노출 ρ",
        correlation: { n: 30, rho: 0.8, low: 0.6, high: 0.9, tiedPairs: 0 },
        unmeasured: "ORS 대신 대리값을 썼다",
      },
    ];
    expect(decideVerdict(metrics).verdict).toBe("미판정");
  });

  it("두 게이트가 함께 걸리면 사유를 둘 다 남긴다", () => {
    const { verdict, reasons } = decideVerdict(usable({ m3b: 0.1, m7High: 0.2 }));
    expect(verdict).toBe("stop");
    expect(reasons).toHaveLength(2);
  });
});
