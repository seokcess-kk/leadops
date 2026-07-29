import { CompanyStatus, type RawCandidate } from "@leadops/core";
import { describe, expect, it } from "vitest";
import { classifySize, decideExclusion, excludeSettingsFrom, DEFAULT_EXCLUDE_SETTINGS } from "./exclude";

const candidate = (over: Partial<RawCandidate> = {}): RawCandidate => ({
  source: "hira_hospital",
  externalId: "x1",
  industry: "derm",
  name: "테스트피부과의원",
  status: CompanyStatus.parse("active"),
  sizeSignals: {},
  raw: {},
  ...over,
});

describe("decideExclusion", () => {
  it("정상 업체는 통과시킨다", () => {
    const d = decideExclusion(candidate({ sizeSignals: { doctorCount: 2 } }));
    expect(d.excluded).toBe(false);
    expect(d.sizeTier).toBe("small");
  });

  it("폐업·휴업을 제외한다", () => {
    expect(decideExclusion(candidate({ status: CompanyStatus.parse("closed") }))).toMatchObject({
      excluded: true,
      reason: "closed",
    });
    expect(decideExclusion(candidate({ status: CompanyStatus.parse("suspended") }))).toMatchObject({
      excluded: true,
      reason: "suspended",
    });
  });

  it("❗ 가맹점 100개 이상 가맹본부를 제외한다 (설계서 1.5)", () => {
    const d = decideExclusion(candidate({ industry: "franchise", sizeSignals: { storeCount: 100 } }));
    expect(d).toMatchObject({ excluded: true, reason: "franchise_too_large" });
    expect(d.detail).toContain("100");
  });

  it("가맹점 99개는 통과시킨다 (경계)", () => {
    expect(decideExclusion(candidate({ industry: "franchise", sizeSignals: { storeCount: 99 } })).excluded).toBe(false);
  });

  it("가맹점 수 규칙은 프랜차이즈에만 적용한다", () => {
    // 병원에 storeCount 가 실려 오는 일은 없지만, 규칙이 업종을 넘지 않아야 한다.
    expect(decideExclusion(candidate({ industry: "derm", sizeSignals: { storeCount: 500 } })).reason).not.toBe(
      "franchise_too_large",
    );
  });

  it("의사 수가 많으면 대형으로 보고 제외한다", () => {
    const d = decideExclusion(candidate({ sizeSignals: { doctorCount: 21 } }));
    expect(d).toMatchObject({ excluded: true, reason: "too_many_doctors", sizeTier: "large" });
  });

  it("이름이 비면 제외한다", () => {
    expect(decideExclusion(candidate({ name: "   " }))).toMatchObject({ excluded: true, reason: "missing_name" });
  });

  it("❗ 제외 사유에 사람이 읽을 설명이 붙는다", () => {
    const d = decideExclusion(candidate({ sizeSignals: { doctorCount: 50 } }));
    expect(d.detail).toContain("50");
    expect(d.detail).toContain("20");
  });

  it("설정으로 상한을 바꿀 수 있다", () => {
    const loose = { ...DEFAULT_EXCLUDE_SETTINGS, franchiseStoreLimit: 300 };
    const c = candidate({ industry: "franchise", sizeSignals: { storeCount: 150 } });
    expect(decideExclusion(c).excluded).toBe(true);
    expect(decideExclusion(c, loose).excluded).toBe(false);
  });
});

describe("classifySize", () => {
  it("의사 수로 등급을 나눈다", () => {
    expect(classifySize({ doctorCount: 1 }, DEFAULT_EXCLUDE_SETTINGS)).toBe("small");
    expect(classifySize({ doctorCount: 5 }, DEFAULT_EXCLUDE_SETTINGS)).toBe("mid");
    expect(classifySize({ doctorCount: 30 }, DEFAULT_EXCLUDE_SETTINGS)).toBe("large");
  });

  it("가맹점 수로도 등급을 나눈다", () => {
    expect(classifySize({ storeCount: 5 }, DEFAULT_EXCLUDE_SETTINGS)).toBe("small");
    expect(classifySize({ storeCount: 50 }, DEFAULT_EXCLUDE_SETTINGS)).toBe("mid");
    expect(classifySize({ storeCount: 200 }, DEFAULT_EXCLUDE_SETTINGS)).toBe("large");
  });

  it("신호가 없으면 small", () => {
    expect(classifySize({}, DEFAULT_EXCLUDE_SETTINGS)).toBe("small");
  });

  it("여러 신호 중 가장 큰 쪽을 따른다", () => {
    expect(classifySize({ doctorCount: 1, storeCount: 200 }, DEFAULT_EXCLUDE_SETTINGS)).toBe("large");
  });
});

describe("excludeSettingsFrom", () => {
  it("설정이 없으면 기본값을 쓴다", () => {
    expect(excludeSettingsFrom({})).toEqual(DEFAULT_EXCLUDE_SETTINGS);
    expect(excludeSettingsFrom(null)).toEqual(DEFAULT_EXCLUDE_SETTINGS);
  });

  it("설정 값을 반영한다", () => {
    const s = excludeSettingsFrom({ targets: { franchise_store_limit: 50 } });
    expect(s.franchiseStoreLimit).toBe(50);
  });

  it("❗ 형식이 틀리면 조용히 기본값으로 넘어가지 않고 던진다", () => {
    // 설정 오타 때문에 상한이 사라지는 것이 가장 나쁜 실패다.
    expect(() => excludeSettingsFrom({ targets: { franchise_store_limit: "백개" } })).toThrow(/양수가 아닙니다/);
    expect(() => excludeSettingsFrom({ targets: { doctor_count_limit: -1 } })).toThrow(/양수가 아닙니다/);
    expect(() => excludeSettingsFrom({ targets: { branch_count_limit: 0 } })).toThrow(/양수가 아닙니다/);
  });
});
