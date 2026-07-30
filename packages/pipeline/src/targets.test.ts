import { describe, expect, it } from "vitest";
import { industryQuota, targetSettingsFrom } from "./targets";

describe("목표치 설정", () => {
  const valid = { targets: { review_max: 100, final_max: 50, industry_share_max: 0.6 } };

  it("시드 값을 읽는다", () => {
    expect(targetSettingsFrom(valid)).toEqual({ reviewMax: 100, finalMax: 50, industryShareMax: 0.6 });
  });

  it("❗ 섹션이 없으면 통과가 아니라 에러다", () => {
    expect(() => targetSettingsFrom({})).toThrow(/targets/);
  });

  it("상한이 0 이하면 에러다 — 상한이 사라지면 쿼터가 무의미해진다", () => {
    expect(() => targetSettingsFrom({ targets: { ...valid.targets, review_max: 0 } })).toThrow(/review_max/);
    expect(() => targetSettingsFrom({ targets: { ...valid.targets, final_max: -1 } })).toThrow(/final_max/);
  });

  it("비율이 0~1 밖이면 에러다", () => {
    expect(() => targetSettingsFrom({ targets: { ...valid.targets, industry_share_max: 0 } })).toThrow(/share/);
    expect(() => targetSettingsFrom({ targets: { ...valid.targets, industry_share_max: 1.5 } })).toThrow(/share/);
  });

  it("비율 1.0 은 허용한다 (업종 제한 없음)", () => {
    expect(targetSettingsFrom({ targets: { ...valid.targets, industry_share_max: 1 } }).industryShareMax).toBe(1);
  });
});

describe("❗ 업종 쿼터는 절대 개수다 (R2-01)", () => {
  it("상한 × 비율의 내림값이다", () => {
    expect(industryQuota(50, 0.6)).toBe(30);
    expect(industryQuota(100, 0.6)).toBe(60);
  });

  it("순서에 의존하지 않는다 — 첫 건도 통과한다", () => {
    // v2 의 `(n+1)/(total+1) > share` 는 첫 승인조차 거절했다.
    const quota = industryQuota(50, 0.6);
    expect(quota).toBeGreaterThanOrEqual(1);
  });

  it("상한이 작아도 최소 1건은 허용한다", () => {
    expect(industryQuota(2, 0.6)).toBe(1);
  });
});
