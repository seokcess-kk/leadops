import { describe, expect, it } from "vitest";
import { collectionSettingsFrom } from "./collection";

/**
 * 수집 범위 설정.
 *
 * ❗ 이 값이 잘못되면 **10배 넓은 수집**이 조용히 일어난다. 그래서 기본값으로 폴백하지
 *    않고 던진다 — 설정 실수는 리드 품질로 나타나고, 그때는 원인을 찾기 어렵다.
 */

describe("정상 파싱", () => {
  it("name 을 읽는다 (발주자 결정)", () => {
    expect(collectionSettingsFrom({ collection: { hira_scope: "name" } })).toEqual({ hiraScope: "name" });
  });

  it("specialty 도 유효하다 (되돌릴 수 있어야 한다)", () => {
    expect(collectionSettingsFrom({ collection: { hira_scope: "specialty" } })).toEqual({
      hiraScope: "specialty",
    });
  });

  it("다른 키가 함께 있어도 무관하다", () => {
    expect(
      collectionSettingsFrom({ collection: { hira_scope: "name", future_knob: 1 }, targets: {} }),
    ).toEqual({ hiraScope: "name" });
  });
});

describe("❗ 조용히 넘어가지 않는다", () => {
  it("섹션이 없으면 에러다", () => {
    expect(() => collectionSettingsFrom({})).toThrow(/collection/);
    expect(() => collectionSettingsFrom({ collection: null })).toThrow(/collection/);
  });

  it("값이 없으면 에러다", () => {
    expect(() => collectionSettingsFrom({ collection: {} })).toThrow(/hira_scope/);
  });

  it("알 수 없는 값이면 에러다 — 기본값으로 폴백하지 않는다", () => {
    expect(() => collectionSettingsFrom({ collection: { hira_scope: "wide" } })).toThrow(/hira_scope/);
    expect(() => collectionSettingsFrom({ collection: { hira_scope: "NAME" } })).toThrow(/hira_scope/);
    expect(() => collectionSettingsFrom({ collection: { hira_scope: 1 } })).toThrow(/hira_scope/);
  });

  it("에러 메시지가 가능한 값을 알려준다", () => {
    expect(() => collectionSettingsFrom({ collection: { hira_scope: "x" } })).toThrow(/name, specialty/);
  });
});
