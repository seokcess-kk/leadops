import { describe, expect, it } from "vitest";
import { comparisonKeyword, generateKeywords, searchRegion } from "./keywords";

/**
 * 키워드 생성.
 *
 * 생성 개수가 곧 네이버 일 호출 수다(설계서 4.1: 업체당 대표 키워드 3개 × 4채널).
 * 늘리면 쿼터가 선형으로 늘어나므로 상한이 지켜지는지 함께 본다.
 */

describe("지역명 다듬기", () => {
  it("행정 접미사를 뗀다", () => {
    expect(searchRegion("강남구")).toBe("강남");
    expect(searchRegion("해운대구")).toBe("해운대");
    expect(searchRegion("성남시")).toBe("성남");
  });

  it("여러 단계면 마지막 것을 쓴다", () => {
    expect(searchRegion("수원시 영통구")).toBe("영통");
  });

  it("❗ 한 글자만 남으면 원형을 쓴다", () => {
    // `중구` → `중` 은 검색어로 쓸 수 없다.
    expect(searchRegion("중구")).toBe("중구");
    expect(searchRegion("동구")).toBe("동구");
  });

  it("없으면 undefined 다", () => {
    expect(searchRegion(null)).toBeUndefined();
    expect(searchRegion(undefined)).toBeUndefined();
    expect(searchRegion("  ")).toBeUndefined();
  });
});

describe("키워드 생성", () => {
  const input = { name: "라온피부과의원", industry: "derm" as const, regionSigungu: "강남구" };

  it("브랜드와 비브랜드를 만든다", () => {
    const keywords = generateKeywords(input);
    expect(keywords.find((k) => k.kind === "brand")?.keyword).toBe("라온피부과의원");
    expect(keywords.map((k) => k.keyword)).toContain("강남 피부과");
  });

  it("❗ 비브랜드 개수가 상한을 지킨다 (쿼터 예산과 직결)", () => {
    const keywords = generateKeywords(input, 3);
    expect(keywords.filter((k) => k.kind !== "brand").length).toBe(3);
  });

  it("업종별 시술이 롱테일 키워드가 된다", () => {
    const dental = generateKeywords({ ...input, name: "맑은치과의원", industry: "dental" }, 3);
    expect(dental.map((k) => k.keyword)).toContain("강남 임플란트");
  });

  it("❗ 지역을 모르면 브랜드 중심으로만 만든다", () => {
    // 지역 없는 `피부과` 는 전국 단위라 경쟁 비교가 성립하지 않는다.
    const keywords = generateKeywords({ ...input, regionSigungu: null }, 3);
    expect(keywords.filter((k) => k.kind !== "brand").length).toBe(1);
    expect(keywords.find((k) => k.kind === "nonbrand_core")?.keyword).toBe("피부과");
  });

  it("❗ 너무 짧은 상호는 브랜드 키워드로 쓰지 않는다", () => {
    const keywords = generateKeywords({ ...input, name: "온" }, 3);
    expect(keywords.some((k) => k.kind === "brand")).toBe(false);
  });

  it("우선순위가 매겨져 있다", () => {
    const keywords = generateKeywords(input, 3);
    const priorities = keywords.map((k) => k.priority);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
  });

  it("전부 template 출처다 (LLM 초안이 아니다)", () => {
    expect(generateKeywords(input).every((k) => k.source === "template")).toBe(true);
  });

  it("상한이 0 이면 브랜드만 남는다", () => {
    const keywords = generateKeywords(input, 0);
    expect(keywords.every((k) => k.kind === "brand")).toBe(true);
  });
});

describe("경쟁사 비교 키워드 (설계서 4.1 — 1개로 한정)", () => {
  it("비브랜드 대표 키워드 하나만 준다", () => {
    expect(comparisonKeyword({ name: "라온피부과의원", industry: "derm", regionSigungu: "강남구" }))
      .toBe("강남 피부과");
  });

  it("지역이 없으면 업종만으로 만든다", () => {
    expect(comparisonKeyword({ name: "맑은치과의원", industry: "dental" })).toBe("치과");
  });
});
