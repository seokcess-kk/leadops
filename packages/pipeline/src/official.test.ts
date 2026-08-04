import { describe, expect, it } from "vitest";
import { detectContactPages } from "./contactPages";
import { scanHtml } from "./html";
import { CONFIRMED_MIN, judgeOfficial, LIKELY_MIN, unavailableVerdict, type OfficialInput } from "./official";

/**
 * 공식 홈페이지 다신호 판정.
 *
 * 상태 의미를 섞지 않는 것이 이 테스트의 핵심이다:
 *   not_official = 아니라는 **증거**가 있다
 *   uncertain    = 증거가 **없다**
 *   unavailable  = 확인 자체를 **못 했다**
 */

const FULL_PAGE = `
<html><head>
  <title>라온피부과의원 | 강남 피부과</title>
  <meta property="og:site_name" content="라온피부과의원">
</head><body>
  <p>서울특별시 강남구 테헤란로 1길 10</p>
  <p>대표전화 02-1234-5678</p>
  <a href="/contact">오시는 길</a>
  <a href="/about">병원소개</a>
  <p>진료시간 안내와 시술 소개, 의료진 프로필을 확인하실 수 있습니다.
     피부 질환 상담과 레이저 시술 예약을 도와드립니다. 편안한 진료 환경을 준비했습니다.</p>
</body></html>`;

function input(overrides: Partial<OfficialInput> = {}, html = FULL_PAGE): OfficialInput {
  const finalUrl = overrides.finalUrl ?? "https://raon-derm.co.kr/";
  const scan = overrides.scan ?? scanHtml(html);
  return {
    companyName: "라온피부과의원",
    domain: "raon-derm.co.kr",
    finalUrl,
    httpStatus: 200,
    phone: "0212345678",
    regionSigungu: "강남구",
    sharedCompanyCount: 0,
    scan,
    contactCandidates: detectContactPages(scan.links, finalUrl),
    ...overrides,
  };
}

describe("아니라는 증거가 있을 때 — not_official", () => {
  it("애그리게이터 도메인은 점수를 매기지 않고 탈락시킨다", () => {
    const v = judgeOfficial(
      input({ domain: "place.naver.com", finalUrl: "https://place.naver.com/hospital/123" }),
    );
    expect(v.status).toBe("not_official");
    expect(v.signals["disqualified"]).toBe("aggregator");
  });

  it("SNS·블로그도 홈페이지로 인정하지 않는다", () => {
    const v = judgeOfficial(
      input({ domain: "blog.naver.com", finalUrl: "https://blog.naver.com/raonderm" }),
    );
    expect(v.status).toBe("not_official");
    expect(v.signals["disqualified"]).toBe("social");
  });

  it("❗ redirect 후 최종 URL 로 판정한다 (단축 URL 방어)", () => {
    // 등록된 도메인은 자체 도메인이지만 최종 도착지가 플레이스면 공식이 아니다.
    const v = judgeOfficial(
      input({ domain: "raon-derm.co.kr", finalUrl: "https://place.naver.com/hospital/9" }),
    );
    expect(v.status).toBe("not_official");
  });

  it("한 도메인에 업체가 너무 많이 묶이면 애그리게이터로 본다", () => {
    const v = judgeOfficial(input({ sharedCompanyCount: 12 }));
    expect(v.status).toBe("not_official");
    expect(v.signals["disqualified"]).toBe("shared_domain");
    expect(v.signals["sharedCompanyCount"]).toBe(12);
  });
});

describe("신호가 모였을 때 — confirmed", () => {
  it("전화·상호·지역이 모두 맞으면 confirmed 다", () => {
    const v = judgeOfficial(input());
    expect(v.status).toBe("confirmed");
    expect(v.score).toBeGreaterThanOrEqual(CONFIRMED_MIN);
    expect(v.signals["phoneMatch"]).toBe(true);
    expect(v.signals["nameInTitle"]).toBe(true);
    expect(v.signals["regionMatch"]).toBe(true);
  });

  it("근거를 사후에 재구성할 수 있게 적용 신호를 남긴다", () => {
    const v = judgeOfficial(input());
    expect(String(v.signals["applied"])).toContain("phoneMatch:+35");
    expect(String(v.signals["applied"])).toContain("nameInTitle:+30");
  });

  it("임대형 빌더라도 대조가 맞으면 인정한다 (감점만)", () => {
    const own = judgeOfficial(input());
    const builder = judgeOfficial(
      input({ domain: "raonderm.modoo.at", finalUrl: "https://raonderm.modoo.at/" }),
    );
    expect(builder.score).toBeLessThan(own.score);
    expect(builder.status).not.toBe("not_official");
  });
});

describe("증거가 없을 때 — uncertain", () => {
  it("살아 있는 사이트지만 아무것도 대조되지 않으면 uncertain 이다", () => {
    const html = `<html><head><title>HOME</title></head><body>
      <p>${"환영합니다. ".repeat(30)}</p></body></html>`;
    const v = judgeOfficial(input({ phone: null, regionSigungu: null }, html));
    expect(v.status).toBe("uncertain");
    expect(v.score).toBeLessThan(LIKELY_MIN);
  });

  it("❗ 증거 없음을 not_official 로 강등하지 않는다", () => {
    const html = `<html><head><title>준비중</title></head><body><p>홈페이지 준비중입니다</p></body></html>`;
    const v = judgeOfficial(input({ phone: null, regionSigungu: null }, html));
    expect(v.status).toBe("uncertain");
  });

  it("껍데기 페이지는 감점을 받는다", () => {
    const shell = judgeOfficial(input({ phone: null, regionSigungu: null }, `<title>x</title><p>준비중</p>`));
    expect(shell.signals["isShell"]).toBe(true);
    expect(shell.score).toBeLessThan(0);
  });

  it("❗ 본문을 이미지로 넣은 사이트를 껍데기로 오판하지 않는다", () => {
    // 국내 병원 홈페이지의 흔한 형태 — 텍스트는 짧지만 내비게이션이 살아 있다.
    const nav = Array.from({ length: 12 }, (_, i) => `<a href="/m${i}"><img src="/m${i}.png"></a>`).join("");
    const html = `<html><head><title>라온피부과의원</title></head><body>${nav}
      <p>서울 강남구 · 02-1234-5678</p></body></html>`;
    const v = judgeOfficial(input({}, html));
    expect(v.signals["isShell"]).toBe(false);
    expect(v.status).toBe("confirmed");
  });
});

describe("상호 일부만 맞을 때 — likely", () => {
  it("상호는 맞지만 전화가 없으면 likely 다", () => {
    const html = FULL_PAGE.replace("대표전화 02-1234-5678", "대표전화는 이미지로 표기");
    const v = judgeOfficial(input({}, html));
    expect(v.status).toBe("likely");
    expect(v.score).toBeGreaterThanOrEqual(LIKELY_MIN);
    expect(v.score).toBeLessThan(CONFIRMED_MIN);
  });
});

describe("확인하지 못했을 때 — unavailable", () => {
  it("사유를 남긴다", () => {
    const v = unavailableVerdict("robots_disallowed", "raon-derm.co.kr");
    expect(v.status).toBe("unavailable");
    expect(v.score).toBe(0);
    expect(v.signals["reason"]).toBe("robots_disallowed");
  });
});

describe("문의 폼만 있는 업체", () => {
  it("폼은 있는데 연락처 경로가 없으면 표시한다", () => {
    const html = `<html><head><title>라온피부과의원</title></head><body>
      <p>서울 강남구</p><p>02-1234-5678</p><form><input name="q"></form>
      <p>${"내용 ".repeat(60)}</p></body></html>`;
    const v = judgeOfficial(input({}, html));
    expect(v.hasContactFormOnly).toBe(true);
  });

  it("연락처 페이지 링크가 있으면 폼이 있어도 해당하지 않는다", () => {
    const html = FULL_PAGE.replace("</body>", "<form><input name='q'></form></body>");
    expect(judgeOfficial(input({}, html)).hasContactFormOnly).toBe(false);
  });

  it("❗ 이용약관만 있는 것은 연락 경로로 치지 않는다", () => {
    const html = `<html><head><title>라온피부과의원</title></head><body>
      <p>서울 강남구</p><form></form><a href="/terms">이용약관</a>
      <p>${"내용 ".repeat(60)}</p></body></html>`;
    expect(judgeOfficial(input({}, html)).hasContactFormOnly).toBe(true);
  });
});

describe("상호 대조의 함정", () => {
  it("두 글자 상호는 우연히 맞을 수 있어 신호로 쓰지 않는다", () => {
    const v = judgeOfficial(input({ companyName: "온" }, `<title>온천 안내</title>`));
    expect(v.signals["nameInTitle"]).toBe(false);
  });

  it("❗ 신고명의 '의원' 접미가 타이틀에 없어도 상호가 맞으면 발화한다", () => {
    // 골드셋 FN 실사례: 기관명 "기장필피부과의원" · <title>기장필피부과</title>.
    // 신고명은 종별 접미를 강제하지만 사이트는 접미 없이 상호만 쓰는 경우가 흔하다.
    const v = judgeOfficial(
      input(
        { companyName: "기장필피부과의원", phone: null, regionSigungu: null },
        `<title>기장필피부과</title><p>${"본문 ".repeat(60)}</p>`,
      ),
    );
    expect(v.signals["nameInTitle"]).toBe(true);
  });

  it("'병원' 접미도 같다", () => {
    const v = judgeOfficial(
      input(
        { companyName: "화이트치과병원", phone: null, regionSigungu: null },
        `<title>화이트치과</title><p>${"본문 ".repeat(60)}</p>`,
      ),
    );
    expect(v.signals["nameInTitle"]).toBe(true);
  });

  it("❗ '한의원' 은 '의원' 만 떼지 않는다 — 남는 말이 상호가 아니다", () => {
    // "행복한의원" 은 "행복" + "한의원" 이다. "의원" 만 떼면 "행복한" 이 되어
    // 아무 타이틀에나 맞는 수식어가 된다.
    const v = judgeOfficial(
      input(
        { companyName: "행복한의원", phone: null, regionSigungu: null },
        `<title>행복한 이야기</title><p>${"본문 ".repeat(60)}</p>`,
      ),
    );
    expect(v.signals["nameInTitle"]).toBe(false);
  });

  it("접미를 뗀 나머지가 세 글자 미만이면 변형을 쓰지 않는다", () => {
    const v = judgeOfficial(
      input(
        { companyName: "온정의원", phone: null, regionSigungu: null },
        `<title>온정마을 소식</title><p>${"본문 ".repeat(60)}</p>`,
      ),
    );
    expect(v.signals["nameInTitle"]).toBe(false);
  });

  it("영문 상호는 도메인에서도 맞는다", () => {
    const v = judgeOfficial(
      input({
        companyName: "Innisfree",
        domain: "innisfree.com",
        finalUrl: "https://innisfree.com/",
        phone: null,
        regionSigungu: null,
      }, `<title>innisfree official</title><p>${"본문 ".repeat(60)}</p>`),
    );
    expect(v.signals["nameInDomain"]).toBe(true);
  });
});
