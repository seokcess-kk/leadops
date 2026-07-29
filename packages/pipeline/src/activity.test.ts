import type { FeedEntry } from "@leadops/adapters";
import { describe, expect, it } from "vitest";
import { classifyContent, computeActivity, isActive, toKstDate } from "./activity";

/**
 * 채널 활성도.
 *
 * 이 축은 ORS 없이도 성립하는 축소 파이프라인의 핵심이므로(설계서 3절),
 * 네이버 승인 여부와 무관하게 정확해야 한다.
 */

const NOW = new Date("2026-07-30T00:00:00Z");
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 3600 * 1000);
const entry = (days: number, title = "글"): FeedEntry => ({ title, publishedAt: daysAgo(days) });

describe("발행량 집계", () => {
  it("60일·120일 창을 각각 센다", () => {
    const m = computeActivity([entry(5), entry(30), entry(80), entry(200)], 0, NOW);
    expect(m.posts60d).toBe(2);
    expect(m.posts120d).toBe(3);
    expect(m.lastPostAt).toBe(toKstDate(daysAgo(5)));
  });

  it("발행이 없으면 0 이고, 그것도 정상 관측이다", () => {
    const m = computeActivity([], 0, NOW);
    expect(m.analyzable).toBe(true);
    expect(m.posts60d).toBe(0);
    expect(isActive(m)).toBe(false);
  });

  it("60일 안에 글이 있으면 활성이다", () => {
    expect(isActive(computeActivity([entry(10)], 0, NOW))).toBe(true);
    expect(isActive(computeActivity([entry(90)], 0, NOW))).toBe(false);
  });
});

describe("❗ 피드 포화 — 카운트가 하한임을 표시한다", () => {
  it("피드가 120일을 못 덮으면 saturated 다", () => {
    // 유튜브 공개 피드는 15건 고정이다. 매일 올리는 채널은 2주치밖에 안 나온다.
    const busy = Array.from({ length: 15 }, (_, i) => entry(i));
    const m = computeActivity(busy, 0, NOW);
    expect(m.saturated).toBe(true);
    expect(m.posts120d).toBe(15);
  });

  it("가장 오래된 글이 120일 밖이면 창을 덮은 것이다", () => {
    const m = computeActivity([entry(5), entry(200)], 0, NOW);
    expect(m.saturated).toBe(false);
  });

  it("❗ 포화는 '활동 부족' 판정을 뒤집지 않는다 (하한이 이미 크다)", () => {
    const busy = Array.from({ length: 15 }, (_, i) => entry(i));
    expect(isActive(computeActivity(busy, 0, NOW))).toBe(true);
  });
});

describe("발행 주기", () => {
  it("발행 간격의 중앙값을 낸다", () => {
    const m = computeActivity([entry(0), entry(7), entry(14), entry(21)], 0, NOW);
    expect(m.cadenceDays).toBe(7);
  });

  it("몰아쓰기에 휘둘리지 않는다 (평균이 아니라 중앙값)", () => {
    // 하루에 3개 몰아쓰고 100일 쉬었다 → 평균은 25일, 중앙값은 0일에 가깝다
    const m = computeActivity([entry(0), entry(0), entry(1), entry(101)], 0, NOW);
    expect(m.cadenceDays).toBeLessThan(2);
  });

  it("글이 하나면 주기를 낼 수 없다", () => {
    expect(computeActivity([entry(3)], 0, NOW).cadenceDays).toBeUndefined();
  });
});

describe("❗ 날짜를 믿을 수 없으면 분석하지 않는다", () => {
  it("절반 넘게 날짜가 없으면 unanalyzable 이다", () => {
    const m = computeActivity([entry(1), { title: "a" }, { title: "b" }], 2, NOW);
    expect(m.analyzable).toBe(false);
    expect(m.unavailableReason).toBe("feed_dates_unparsable");
    expect(isActive(m)).toBeNull();
  });

  it("날짜가 하나도 없으면 unanalyzable 이다", () => {
    const m = computeActivity([{ title: "a" }, { title: "b" }], 2, NOW);
    expect(m.analyzable).toBe(false);
  });

  it("일부만 없으면 있는 것으로 계산한다", () => {
    const m = computeActivity([entry(1), entry(2), entry(3), { title: "x" }], 1, NOW);
    expect(m.analyzable).toBe(true);
    expect(m.posts60d).toBe(3);
  });
});

describe("콘텐츠 성격 분류", () => {
  it("이벤트성 문구를 먼저 잡는다", () => {
    expect(classifyContent("7월 여드름 이벤트 안내")).toBe("event");
    expect(classifyContent("가을맞이 할인 프로모션")).toBe("event");
  });

  it("공지·후기·정보를 나눈다", () => {
    expect(classifyContent("추석 연휴 휴진 공지")).toBe("notice");
    expect(classifyContent("레이저 시술 후기")).toBe("review");
    expect(classifyContent("여드름 원인과 치료 방법")).toBe("info");
  });

  it("분류되지 않으면 etc 다", () => {
    expect(classifyContent("안녕하세요")).toBe("etc");
    expect(classifyContent("")).toBe("etc");
  });

  it("분포의 합이 날짜 있는 항목 수와 같다", () => {
    const m = computeActivity(
      [entry(1, "이벤트"), entry(2, "후기"), entry(3, "잡담"), { title: "날짜없음" }],
      1,
      NOW,
    );
    const sum = Object.values(m.contentMix).reduce((a, b) => a + b, 0);
    expect(sum).toBe(3);
  });
});

describe("KST 날짜", () => {
  it("UTC 기준 자정 직전도 한국 날짜로 넘긴다", () => {
    expect(toKstDate(new Date("2026-07-29T16:00:00Z"))).toBe("2026-07-30");
    expect(toKstDate(new Date("2026-07-29T14:00:00Z"))).toBe("2026-07-29");
  });
});
