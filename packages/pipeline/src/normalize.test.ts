import { CompanyStatus, type RawCandidate } from "@leadops/core";
import { describe, expect, it } from "vitest";
import {
  buildDedupeKey,
  buildGroupKey,
  canonicalSido,
  normalizeBizNo,
  normalizeCompanyName,
  normalizeCorpNo,
  normalizePhone,
} from "./normalize";

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

describe("normalizeCompanyName", () => {
  it("법인격 표기를 제거한다", () => {
    expect(normalizeCompanyName("의료법인 성모의원")).toBe("성모의원");
    expect(normalizeCompanyName("재단법인 한국병원")).toBe("한국병원");
    expect(normalizeCompanyName("주식회사 테스트")).toBe("테스트");
  });

  it("괄호 안 법인격 약어를 제거한다", () => {
    expect(normalizeCompanyName("(의)미래의료재단리드림의원")).toBe(normalizeCompanyName("미래의료재단리드림의원"));
    expect(normalizeCompanyName("(사)한국건강관리협회")).toBe("한국건강관리협회");
    expect(normalizeCompanyName("(주)루트로닉부속의원")).toBe("루트로닉부속의원");
  });

  it("공백·구두점 차이를 흡수한다", () => {
    expect(normalizeCompanyName("강남 피부과 의원")).toBe(normalizeCompanyName("강남피부과의원"));
    expect(normalizeCompanyName("연세·본치과")).toBe(normalizeCompanyName("연세본치과"));
    expect(normalizeCompanyName("A&B 의원")).toBe(normalizeCompanyName("ab의원"));
  });

  it("전각을 반각으로 정규화한다", () => {
    expect(normalizeCompanyName("ＡＢＣ의원")).toBe(normalizeCompanyName("ABC의원"));
  });

  it("영문 대소문자를 무시한다", () => {
    expect(normalizeCompanyName("SKIN의원")).toBe(normalizeCompanyName("skin의원"));
  });

  it("❗ 지점명은 남긴다 (다른 업체이므로)", () => {
    expect(normalizeCompanyName("연세치과 강남점")).not.toBe(normalizeCompanyName("연세치과 서초점"));
  });

  it("전부 제거되면 빈 문자열", () => {
    expect(normalizeCompanyName("(주)")).toBe("");
    expect(normalizeCompanyName("   ---   ")).toBe("");
  });
});

describe("식별번호 정규화", () => {
  it("사업자번호는 10자리만 인정한다", () => {
    expect(normalizeBizNo("123-45-67890")).toBe("1234567890");
    expect(normalizeBizNo("1234567890")).toBe("1234567890");
    expect(normalizeBizNo("12345")).toBeUndefined();
    expect(normalizeBizNo(undefined)).toBeUndefined();
  });

  it("법인번호는 13자리만 인정한다", () => {
    expect(normalizeCorpNo("110111-1234567")).toBe("1101111234567");
    expect(normalizeCorpNo("110111")).toBeUndefined();
  });

  it("전화번호는 9~11자리만 인정하고 국가번호를 0 으로 바꾼다", () => {
    expect(normalizePhone("02-1234-5678")).toBe("0212345678");
    expect(normalizePhone("+82-10-1234-5678")).toBe("01012345678");
    expect(normalizePhone("+82 2 1234 5678")).toBe("0212345678");
    expect(normalizePhone("1234")).toBeUndefined();
    expect(normalizePhone("")).toBeUndefined();
  });
});

describe("buildDedupeKey", () => {
  it("사업자번호가 있으면 그것만 쓴다", () => {
    const r = buildDedupeKey(candidate({ bizNo: "123-45-67890", name: "아무이름" }));
    expect(r).toEqual({ key: "biz:1234567890", basis: "biz_no", confidence: "high" });
  });

  it("❗ 사업자번호가 같으면 이름이 달라도 같은 업체다 (상호 변경)", () => {
    const a = buildDedupeKey(candidate({ bizNo: "1234567890", name: "옛날이름의원" }));
    const b = buildDedupeKey(candidate({ bizNo: "1234567890", name: "새이름의원" }));
    expect(a.key).toBe(b.key);
  });

  it("법인번호가 다음 우선순위다", () => {
    const r = buildDedupeKey(candidate({ corpNo: "110111-1234567" }));
    expect(r.basis).toBe("corp_no");
  });

  it("식별번호가 없으면 이름+지역+전화를 쓴다", () => {
    const r = buildDedupeKey(candidate({ regionSigungu: "강남구", phone: "02-1234-5678" }));
    expect(r.basis).toBe("name_region_phone");
    expect(r.confidence).toBe("medium");
  });

  it("전화가 없으면 이름+지역만 쓰되 신뢰도를 낮춘다", () => {
    const r = buildDedupeKey(candidate({ regionSigungu: "강남구" }));
    expect(r.basis).toBe("name_region");
    expect(r.confidence).toBe("low");
  });

  it("❗ 같은 이름이라도 지역이 다르면 다른 업체다", () => {
    const a = buildDedupeKey(candidate({ name: "연세치과", regionSigungu: "강남구" }));
    const b = buildDedupeKey(candidate({ name: "연세치과", regionSigungu: "서초구" }));
    expect(a.key).not.toBe(b.key);
  });

  it("❗ 표기만 다른 같은 업체는 같은 키가 된다", () => {
    const a = buildDedupeKey(candidate({ name: "(의) 강남 피부과의원", regionSigungu: "강남구", phone: "02-111-2222" }));
    const b = buildDedupeKey(candidate({ name: "강남피부과의원", regionSigungu: "강남구", phone: "021112222" }));
    expect(a.key).toBe(b.key);
  });

  it("❗ 이름이 정규화 후 비면 병합하지 않고 고립시킨다", () => {
    const r = buildDedupeKey(candidate({ name: "(주)", externalId: "e9" }));
    expect(r.basis).toBe("source_id");
    expect(r.key).toContain("e9");
  });

  it("이름이 빈 두 후보가 서로 병합되지 않는다", () => {
    const a = buildDedupeKey(candidate({ name: "---", externalId: "a" }));
    const b = buildDedupeKey(candidate({ name: "---", externalId: "b" }));
    expect(a.key).not.toBe(b.key);
  });
});

describe("buildGroupKey", () => {
  it("법인번호가 있으면 법인 단위로 묶는다", () => {
    const r = buildGroupKey(candidate({ corpNo: "110111-1234567" }))!;
    expect(r.kind).toBe("corporation");
    expect(r.key).toBe("corp:1101111234567");
  });

  it("프랜차이즈는 브랜드 단위로 묶는다", () => {
    const r = buildGroupKey(candidate({ industry: "franchise", externalId: "B-1" }))!;
    expect(r.kind).toBe("brand");
  });

  it("❗ 이름만으로는 묶지 않는다 ('연세치과' 는 전국에 무관하게 많다)", () => {
    expect(buildGroupKey(candidate({ name: "연세치과" }))).toBeUndefined();
  });
});

describe("canonicalSido", () => {
  it("축약형을 표준형으로 바꾼다", () => {
    expect(canonicalSido("서울")).toBe("서울특별시");
    expect(canonicalSido("서울특별시")).toBe("서울특별시");
    expect(canonicalSido("경기")).toBe("경기도");
    expect(canonicalSido("전북")).toBe("전북특별자치도");
  });

  it("광주광역시와 경기 광주시를 구분한다", () => {
    expect(canonicalSido("광주")).toBe("광주광역시");
    expect(canonicalSido("광주시")).toBe("광주시");
  });

  it("모르는 값은 그대로 둔다", () => {
    expect(canonicalSido("알수없음")).toBe("알수없음");
    expect(canonicalSido(undefined)).toBeUndefined();
    expect(canonicalSido("  ")).toBeUndefined();
  });
});
