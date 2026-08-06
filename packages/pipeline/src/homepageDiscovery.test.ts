import { describe, expect, it } from "vitest";
import {
  discoverHomepage,
  discoverHomepageFromWebSearch,
  discoveryQuery,
  evidenceFor,
  normalizeName,
  normalizePhone,
  type KnownCompany,
  type LocalCandidate,
} from "./homepageDiscovery";

/**
 * 홈페이지 발견 — **잘못된 업체를 채택하는 경로**를 고정한다.
 *
 * 이 단계의 위험은 "못 찾는 것" 이 아니라 **엉뚱한 사이트를 그 업체 것으로 저장하는 것**이다.
 * 그러면 점수·취약점·추천이 전부 다른 업체 기준으로 계산되고, 검수자는 그것을 알 방법이 없다.
 */

const known: KnownCompany = {
  name: "강남삼성피부과의원",
  phone: "02-555-1234",
  address: "서울특별시 강남구 테헤란로 1",
  regionSigungu: "강남구",
};

const hit = (over: Partial<LocalCandidate> = {}): LocalCandidate => ({
  title: "강남삼성피부과의원",
  link: "https://gangnam-samsung.co.kr",
  telephone: "02-555-1234",
  address: "서울특별시 강남구 테헤란로 1",
  roadAddress: "서울특별시 강남구 테헤란로 1",
  ...over,
});

describe("normalizePhone", () => {
  it("표기가 달라도 같은 번호로 본다", () => {
    expect(normalizePhone("02-555-1234")).toBe(normalizePhone("025551234"));
    expect(normalizePhone("(02) 555-1234")).toBe("025551234");
  });

  it("❗ 너무 짧은 값은 비교하지 않는다 (대표번호 조각이 우연히 겹친다)", () => {
    expect(normalizePhone("1588")).toBeUndefined();
    expect(normalizePhone("")).toBeUndefined();
    expect(normalizePhone(null)).toBeUndefined();
    expect(normalizePhone(undefined)).toBeUndefined();
  });
});

describe("normalizeName", () => {
  it("법인격·괄호·공백을 지운다", () => {
    expect(normalizeName("(사)한국건강관리협회 건강치과의원")).toBe(
      normalizeName("한국건강관리협회건강치과의원"),
    );
  });
});

describe("evidenceFor", () => {
  it("전화가 일치하면 채택 근거가 된다", () => {
    expect(evidenceFor(known, hit())).toBe("phone_match");
  });

  it("❗ 전화가 일치하면 상호가 달라도 채택한다 (공공 API 대표번호가 더 강한 근거다)", () => {
    expect(evidenceFor(known, hit({ title: "완전히 다른 이름" }))).toBe("phone_match");
  });

  it("전화가 없으면 상호와 지역이 **둘 다** 맞아야 한다", () => {
    const noPhone = hit({ telephone: undefined });
    expect(evidenceFor(known, noPhone)).toBe("name_and_region_match");
  });

  it("❗ 상호만 맞고 지역이 다르면 거절한다 (동명이인)", () => {
    const otherRegion = hit({
      telephone: "051-999-8888",
      address: "부산광역시 해운대구 센텀로 9",
      roadAddress: "부산광역시 해운대구 센텀로 9",
    });
    expect(evidenceFor(known, otherRegion)).toBeUndefined();
  });

  it("❗ 지역만 맞고 상호가 다르면 거절한다 (옆 건물 다른 병원)", () => {
    const otherName = hit({ title: "강남메디컬정형외과", telephone: "02-777-0000" });
    expect(evidenceFor(known, otherName)).toBeUndefined();
  });

  it("❗ 전화가 서로 다르면 전화 근거를 쓰지 않는다", () => {
    // 전화가 다르지만 상호·지역이 맞으므로 약한 근거로만 통과한다.
    expect(evidenceFor(known, hit({ telephone: "02-000-0000" }))).toBe("name_and_region_match");
  });

  it("우리 전화가 없으면 전화 근거를 쓸 수 없다", () => {
    expect(evidenceFor({ ...known, phone: null }, hit())).toBe("name_and_region_match");
  });

  it("시군구를 모르면 약한 근거도 쓸 수 없다", () => {
    const noRegion = { ...known, phone: null, regionSigungu: null };
    expect(evidenceFor(noRegion, hit({ telephone: undefined }))).toBeUndefined();
  });

  it("너무 짧은 상호는 부분일치로 통과시키지 않는다", () => {
    const shortName = { ...known, name: "아", phone: null };
    expect(evidenceFor(shortName, hit({ title: "아름다운피부과", telephone: undefined }))).toBeUndefined();
  });
});

describe("discoverHomepage", () => {
  it("근거가 있으면 URL 을 돌려준다", () => {
    const result = discoverHomepage(known, [hit()]);
    expect(result.url).toBe("https://gangnam-samsung.co.kr");
    expect(result.basis).toBe("phone_match");
  });

  it("❗ 애그리게이터·SNS 링크는 요청 전에 잘라낸다", () => {
    for (const link of [
      "https://blog.naver.com/gangnam-samsung",
      "https://m.place.naver.com/hospital/12345",
      "https://www.instagram.com/gangnamsamsung",
    ]) {
      const result = discoverHomepage(known, [hit({ link })]);
      expect(result.url, `${link} 은 후보가 되면 안 된다`).toBeUndefined();
      expect(result.rejected).toBe("disqualifying_domain");
    }
  });

  it("❗ 순위가 높다는 이유로 고르지 않는다 — 근거가 있는 것만 고른다", () => {
    const results = discoverHomepage(known, [
      // 1위: 전혀 다른 업체
      hit({ title: "역삼우리내과", link: "https://yeoksam-uri.kr", telephone: "02-111-2222", address: "서울특별시 강남구 역삼로 5", roadAddress: "서울특별시 강남구 역삼로 5" }),
      // 2위: 우리 업체
      hit({ link: "https://gangnam-samsung.co.kr" }),
    ]);
    expect(results.url).toBe("https://gangnam-samsung.co.kr");
    expect(results.basis).toBe("phone_match");
  });

  it("❗ 전화 일치를 상호+지역 일치보다 우선한다", () => {
    const weakFirst = hit({
      title: "강남삼성피부과의원",
      link: "https://weak-match.kr",
      telephone: undefined,
    });
    const strongLater = hit({ title: "다른이름", link: "https://strong-match.kr" });
    const result = discoverHomepage(known, [weakFirst, strongLater]);
    expect(result.url).toBe("https://strong-match.kr");
    expect(result.basis).toBe("phone_match");
  });

  it("근거가 하나도 없으면 거절 사유를 남긴다", () => {
    const stranger = hit({
      title: "부산해운대치과",
      link: "https://busan-dental.kr",
      telephone: "051-1",
      address: "부산광역시 해운대구",
      roadAddress: "부산광역시 해운대구",
    });
    const result = discoverHomepage(known, [stranger]);
    expect(result.url).toBeUndefined();
    expect(result.rejected).toBe("no_matching_evidence");
    expect(result.considered).toBe(1);
  });

  it("후보가 없으면 no_candidates 다 (0건과 '못 찾음' 을 구분한다)", () => {
    expect(discoverHomepage(known, []).rejected).toBe("no_candidates");
  });

  it("링크가 비어 있거나 형식이 틀리면 사유를 구분한다", () => {
    expect(discoverHomepage(known, [hit({ link: "" })]).rejected).toBe("no_link");
    expect(discoverHomepage(known, [hit({ link: "not a url" })]).rejected).toBe("invalid_url");
    // http/https 가 아닌 스킴도 거절한다 (SSRF 방어는 별도지만 여기서도 자른다).
    expect(discoverHomepage(known, [hit({ link: "javascript:alert(1)" })]).rejected).toBe("invalid_url");
    expect(discoverHomepage(known, [hit({ link: "file:///etc/passwd" })]).rejected).toBe("invalid_url");
  });
});

describe("discoveryQuery", () => {
  it("시군구를 붙여 전국 동명 업체가 섞이지 않게 한다", () => {
    expect(discoveryQuery(known)).toBe("강남구 강남삼성피부과의원");
  });

  it("시군구를 모르면 상호만 보낸다", () => {
    expect(discoveryQuery({ ...known, regionSigungu: null })).toBe("강남삼성피부과의원");
  });
});

describe("웹검색 폴백 — 텍스트 근거 (discoverHomepageFromWebSearch)", () => {
  const known = { name: "기장필피부과의원", phone: null, regionSigungu: "기장군" };

  it("상호(접미 완화)와 시군구가 제목·설명에 함께 나타나면 채택한다", () => {
    // 실사례 패턴: 사이트 제목은 종별 접미 없이 "기장필피부과" 로 적힌다.
    const r = discoverHomepageFromWebSearch(known, [
      { title: "기장필피부과 - 부산 기장군 피부과전문의", link: "https://feelskin.kr/", description: "" },
    ]);
    expect(r.url).toBe("https://feelskin.kr/");
    expect(r.basis).toBe("name_region_text");
  });

  it("❗ 상호만 맞으면 거절한다 — 동명이인", () => {
    const r = discoverHomepageFromWebSearch(known, [
      { title: "기장필피부과 예약 안내", link: "https://someone.kr/", description: "빠른 예약" },
    ]);
    expect(r.url).toBeUndefined();
    expect(r.rejected).toBe("no_text_evidence");
  });

  it("❗ 시군구만 맞으면 거절한다 — 옆 건물 다른 병원", () => {
    const r = discoverHomepageFromWebSearch(known, [
      { title: "기장군 피부 관리 잘하는 곳", link: "https://other.kr/", description: "기장군 추천" },
    ]);
    expect(r.rejected).toBe("no_text_evidence");
  });

  it("❗ 애그리게이터·SNS 링크는 텍스트가 맞아도 요청 전에 자른다", () => {
    const r = discoverHomepageFromWebSearch(known, [
      { title: "기장필피부과", link: "https://blog.naver.com/feelskin", description: "기장군" },
    ]);
    expect(r.url).toBeUndefined();
    expect(r.rejected).toBe("disqualifying_domain");
  });

  it("❗ 순위는 근거가 아니다 — 무근거 1위를 건너뛰고 근거 있는 2위를 채택한다", () => {
    const r = discoverHomepageFromWebSearch(known, [
      { title: "피부과 순위 TOP10", link: "https://rank.kr/", description: "전국" },
      { title: "기장필피부과 | 기장군", link: "https://feelskin.kr/", description: "" },
    ]);
    expect(r.url).toBe("https://feelskin.kr/");
  });

  it("시군구를 모르는 업체는 텍스트 근거가 성립하지 않는다", () => {
    const r = discoverHomepageFromWebSearch({ name: "기장필피부과의원", regionSigungu: null }, [
      { title: "기장필피부과 기장군", link: "https://feelskin.kr/", description: "" },
    ]);
    expect(r.rejected).toBe("no_text_evidence");
  });

  it("결과가 없으면 no_candidates 다", () => {
    expect(discoverHomepageFromWebSearch(known, []).rejected).toBe("no_candidates");
  });
});
