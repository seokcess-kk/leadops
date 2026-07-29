import { describe, expect, it } from "vitest";
import { classifyDomain, isDisqualifyingClass } from "./aggregators";

/**
 * 도메인 분류 (설계서 R10 — 애그리게이터를 공식 홈페이지로 오판하지 않는다).
 */

describe("애그리게이터", () => {
  it("병원 포털·지도·예약 도메인을 잡는다", () => {
    for (const d of ["place.naver.com", "map.kakao.com", "goodoc.co.kr", "gangnamunni.com"]) {
      expect(classifyDomain(d), d).toBe("aggregator");
    }
  });

  it("채용 사이트도 공식 홈페이지가 아니다", () => {
    expect(classifyDomain("saramin.co.kr")).toBe("aggregator");
    expect(classifyDomain("jobkorea.co.kr")).toBe("aggregator");
  });
});

describe("SNS · 블로그", () => {
  it("공식 채널일 수는 있으나 홈페이지는 아니다", () => {
    for (const d of ["blog.naver.com", "cafe.naver.com", "instagram.com", "youtube.com", "tistory.com"]) {
      expect(classifyDomain(d), d).toBe("social");
    }
  });

  it("서브도메인으로 붙어도 잡는다", () => {
    expect(classifyDomain("raonclinic.tistory.com")).toBe("social");
    expect(classifyDomain("m.blog.naver.com")).toBe("social");
  });
});

describe("빌더 — 배제하지 않고 감점만", () => {
  it("임대형 홈페이지를 구분한다", () => {
    expect(classifyDomain("raonderm.modoo.at")).toBe("builder");
    expect(classifyDomain("shop123.cafe24.com")).toBe("builder");
    expect(classifyDomain("clinic.imweb.me")).toBe("builder");
  });

  it("❗ 빌더는 실격 사유가 아니다", () => {
    expect(isDisqualifyingClass("builder")).toBe(false);
    expect(isDisqualifyingClass("own")).toBe(false);
    expect(isDisqualifyingClass("aggregator")).toBe(true);
    expect(isDisqualifyingClass("social")).toBe(true);
  });
});

describe("❗ 레이블 경계", () => {
  it("접미사가 우연히 겹치는 도메인을 오분류하지 않는다", () => {
    expect(classifyDomain("notinstagram.com")).toBe("own");
    expect(classifyDomain("myyoutube.co.kr")).toBe("own");
    expect(classifyDomain("cafe24clinic.co.kr")).toBe("own");
  });

  it("자체 도메인은 own 이다", () => {
    expect(classifyDomain("raon-derm.co.kr")).toBe("own");
    expect(classifyDomain("ediya.co.kr")).toBe("own");
  });
});

describe("정규화", () => {
  it("www 와 대문자, 후행 점을 무시한다", () => {
    expect(classifyDomain("WWW.Instagram.com")).toBe("social");
    expect(classifyDomain("place.naver.com.")).toBe("aggregator");
  });
});

describe("단축 URL", () => {
  it("단축 도메인을 따로 분류한다 (최종 URL 로 재판정해야 한다)", () => {
    expect(classifyDomain("naver.me")).toBe("shortener");
    expect(classifyDomain("bit.ly")).toBe("shortener");
  });
});
