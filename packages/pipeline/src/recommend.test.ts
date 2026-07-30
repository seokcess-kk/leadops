import { describe, expect, it } from "vitest";
import { recommend, SERVICES, type RecommendInput } from "./recommend";
import type { ScoreItem } from "./scoring";
import type { Weakness } from "./weakness";

/**
 * 추천 서비스 매핑 (설계서 부록 A.7).
 *
 * ❗ **선정은 규칙이 한다.** 이 테스트가 통과하는 한 LLM 없이도 추천이 나온다
 *    (`FEATURE_LLM=off` 전체 통과가 Phase 5 완료 기준).
 */

const item = (key: string, points: number, max = points): ScoreItem => ({ key, label: key, points, max });

const input = (problem: ScoreItem[], propensity: ScoreItem[] = [], weaknesses: Weakness[] = []): RecommendInput => ({
  problem: { items: problem },
  propensity: { items: propensity },
  weaknesses,
});

describe("주력 선정", () => {
  it("가장 큰 문제 항목의 서비스를 주력으로 고른다", () => {
    const r = recommend(input([item("content_60d", 8), item("gap_recency", 5)]));
    expect(r.primaryService).toBe("콘텐츠 마케팅");
  });

  it("경쟁사 격차가 가장 크면 매체 광고다", () => {
    const r = recommend(input([item("gap_recency", 5), item("gap_activity", 3), item("content_60d", 2, 8)]));
    expect(r.primaryService).toBe("매체 광고");
  });

  it("ORS 공백이 가장 크면 검색 점유·SEO 다", () => {
    const r = recommend(input([item("ors_no_official", 10), item("content_60d", 8)]));
    expect(r.primaryService).toBe("검색 점유·SEO 콘텐츠");
  });

  it("보조는 최대 2개다", () => {
    const r = recommend(
      input([item("ors_no_official", 10), item("gap_recency", 5), item("content_60d", 4), item("contact_exists", 0, 3)]),
    );
    expect(r.secondaryServices.length).toBeLessThanOrEqual(2);
    expect(r.secondaryServices).not.toContain(r.primaryService);
  });

  it("동점이면 설계서 우선순위를 따른다", () => {
    const r = recommend(input([item("ors_no_official", 5), item("gap_recency", 5)]));
    expect(r.primaryService).toBe("검색 점유·SEO 콘텐츠");
    expect(SERVICES.indexOf(r.primaryService)).toBeLessThan(SERVICES.indexOf("매체 광고"));
  });
});

describe("❗ 접점 품질은 방향이 반대다", () => {
  it("연락처 점수가 낮을수록 홈페이지 개선이 필요하다", () => {
    // 문제 항목이 없고 접점만 0점이면 홈페이지 개선이 주력이어야 한다.
    const r = recommend(input([], [item("contact_exists", 0, 3), item("contact_kind", 0, 2)]));
    expect(r.primaryService).toBe("홈페이지 개선");
  });

  it("연락처가 충분하면 홈페이지 개선이 나오지 않는다", () => {
    const r = recommend(input([item("content_60d", 8)], [item("contact_exists", 3, 3), item("contact_kind", 2, 2)]));
    expect(r.primaryService).not.toBe("홈페이지 개선");
    expect(r.secondaryServices).not.toContain("홈페이지 개선");
  });
});

describe("측정 불가 항목은 근거가 되지 않는다", () => {
  it("unavailable 항목은 무시한다", () => {
    const r = recommend(
      input([{ key: "competitor_gap", label: "격차", points: 0, max: 12, unavailable: true }, item("content_60d", 8)]),
    );
    expect(r.primaryService).toBe("콘텐츠 마케팅");
  });

  it("매핑이 없는 항목은 근거가 되지 않는다", () => {
    // 지역 경쟁강도는 문제가 아니라 시장 조건이다.
    const r = recommend(input([], [item("local_competition", 3), item("industry_ticket", 4)]));
    expect(r.secondaryServices.length).toBe(0);
  });
});

describe("근거 문장", () => {
  it("항목 이름과 강한 취약점을 담는다", () => {
    const r = recommend(
      input([item("content_60d", 8)], [], [{ kind: "no_official_channel", severity: "strong", label: "공식 채널 없음" }]),
    );
    expect(r.rationale).toContain("콘텐츠 마케팅");
    expect(r.rationale).toContain("공식 채널 없음");
  });

  it("❗ 출처가 규칙임을 표시한다 (LLM 아님)", () => {
    expect(recommend(input([item("content_60d", 8)])).rationaleSource).toBe("rule");
  });

  it("문제 항목이 없어도 던지지 않고 폴백한다", () => {
    const r = recommend(input([]));
    expect(SERVICES).toContain(r.primaryService);
    expect(r.rationale).toContain("관측된 문제 항목 없음");
  });
});
