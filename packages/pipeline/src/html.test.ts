import { describe, expect, it } from "vitest";
import { phoneAppears, scanHtml } from "./html";

/**
 * HTML 스캐너.
 *
 * 여기서 지키려는 것은 두 가지다.
 *  1. 스크립트·스타일 안의 내용이 신호로 새어 나오지 않는다
 *  2. 전화번호 대조가 블록 경계를 넘어 우연히 맞지 않는다
 */

describe("메타데이터 추출", () => {
  it("title · og:site_name · description 을 읽는다", () => {
    const scan = scanHtml(`
      <html><head>
        <title>  라온피부과의원  </title>
        <meta property="og:site_name" content="라온피부과">
        <meta name="description" content="강남 피부과">
      </head><body>x</body></html>`);

    expect(scan.title).toBe("라온피부과의원");
    expect(scan.siteName).toBe("라온피부과");
    expect(scan.description).toBe("강남 피부과");
  });

  it("og:description 도 description 으로 받는다", () => {
    const scan = scanHtml(`<meta property="og:description" content="설명">`);
    expect(scan.description).toBe("설명");
  });

  it("title 이 없으면 필드 자체가 없다", () => {
    const scan = scanHtml("<html><body>내용</body></html>");
    expect(scan.title).toBeUndefined();
  });
});

describe("noindex 판정 (F-25 — 차단 사유가 아니라 메타데이터)", () => {
  it("robots 지시에서 noindex 를 찾는다", () => {
    expect(scanHtml(`<meta name="robots" content="noindex, follow">`).hasNoindex).toBe(true);
    expect(scanHtml(`<meta name="googlebot" content="noindex">`).hasNoindex).toBe(true);
  });

  it("❗ index 만 있는 문서를 noindex 로 오인하지 않는다", () => {
    expect(scanHtml(`<meta name="robots" content="index, follow">`).hasNoindex).toBe(false);
  });

  it("❗ 토큰 경계를 지킨다 — noindexing 은 noindex 가 아니다", () => {
    expect(scanHtml(`<meta name="robots" content="noindexing">`).hasNoindex).toBe(false);
  });
});

describe("❗ script · style 격리", () => {
  const html = `
    <body>
      <p>본문</p>
      <script>var link = "<a href='/gotcha'>클릭</a>"; var phone = "0311112222";</script>
      <style>.a { content: "0299998888"; }</style>
      <a href="/real">진짜 링크</a>
    </body>`;

  it("스크립트 문자열 안의 <a> 를 링크로 잡지 않는다", () => {
    const scan = scanHtml(html);
    expect(scan.links.map((l) => l.href)).toEqual(["/real"]);
  });

  it("스크립트·스타일 안의 숫자가 전화 대조에 쓰이지 않는다", () => {
    const scan = scanHtml(html);
    expect(phoneAppears(scan, "0311112222")).toBe(false);
    expect(phoneAppears(scan, "0299998888")).toBe(false);
  });
});

describe("껍데기 리다이렉트 목적지 추출", () => {
  it("meta refresh 의 url 을 읽는다", () => {
    const scan = scanHtml(
      `<html><head><meta http-equiv="refresh" content="0;url=/main/"></head></html>`,
    );
    expect(scan.redirectTarget).toBe("/main/");
  });

  it("인라인 스크립트의 location 이동을 읽는다 — 마지막 대입이 목적지다", () => {
    // 실사례(골드셋 FN): UA 분기로 모바일(/m/)을 먼저, 데스크톱(/index.php)을 나중에
    // 대입한다. JS 를 실행하지 않으므로 분기를 평가할 수 없고, 마지막 대입을 취한다.
    const scan = scanHtml(`<html><head><script>
      if (navigator.userAgent.match(/iPhone|Android/) != null) {
        location.href = "/m/";
      } else {
        location.href = "/index.php";
      }
    </script></head></html>`);
    expect(scan.redirectTarget).toBe("/index.php");
  });

  it("meta refresh 가 스크립트 이동보다 우선한다", () => {
    const scan = scanHtml(
      `<head><meta http-equiv="refresh" content="0; URL='/meta/'"><script>location.href = "/js/";</script></head>`,
    );
    expect(scan.redirectTarget).toBe("/meta/");
  });

  it("이동이 없으면 필드 자체가 없다", () => {
    expect(scanHtml(`<html><body>본문</body></html>`).redirectTarget).toBeUndefined();
  });

  it("❗ 목적지 추출이 스크립트 격리를 깨지 않는다 — 링크·숫자 신호는 그대로다", () => {
    const scan = scanHtml(
      `<script>location.href = "/index.php"; var p = "0312345678";</script>`,
    );
    expect(scan.redirectTarget).toBe("/index.php");
    expect(scan.links).toHaveLength(0);
    expect(phoneAppears(scan, "0312345678")).toBe(false);
  });
});

describe("전화번호 대조", () => {
  it("인라인 태그로 쪼개진 번호를 이어 붙여 맞춘다", () => {
    const scan = scanHtml(`<div>대표전화 <span>02</span>-<span>1234</span>-<b>5678</b></div>`);
    expect(phoneAppears(scan, "0212345678")).toBe(true);
  });

  it("❗ 인접한 표 셀이 합쳐져 우연히 맞는 일이 없다", () => {
    // "100" + "212345678" 이 붙으면 "0212345678" 을 포함하게 된다.
    const scan = scanHtml(`<table><tr><td>100</td><td>212345678</td></tr></table>`);
    expect(phoneAppears(scan, "0212345678")).toBe(false);
  });

  it("+82 국가번호 표기도 같은 번호로 본다", () => {
    const scan = scanHtml(`<p>Tel. +82-2-1234-5678</p>`);
    expect(phoneAppears(scan, "0212345678")).toBe(true);
  });

  it("tel: 링크의 번호도 대조 대상이다", () => {
    const scan = scanHtml(`<a href="tel:02-987-6543">전화걸기</a>`);
    expect(phoneAppears(scan, "029876543")).toBe(true);
  });

  it("번호가 없거나 너무 짧으면 맞지 않는다", () => {
    const scan = scanHtml(`<p>1234</p>`);
    expect(phoneAppears(scan, undefined)).toBe(false);
    expect(phoneAppears(scan, null)).toBe(false);
    expect(phoneAppears(scan, "1234")).toBe(false);
  });
});

describe("링크 수집", () => {
  it("href 가 없는 앵커는 세지 않는다", () => {
    const scan = scanHtml(`<a>이름표</a><a href="/a">A</a>`);
    expect(scan.linkCount).toBe(1);
  });

  it("앵커 텍스트의 공백을 정규화한다", () => {
    const scan = scanHtml(`<a href="/a">  오시는   길  </a>`);
    expect(scan.links[0]!.text).toBe("오시는 길");
  });

  it("rel 을 보존한다", () => {
    const scan = scanHtml(`<a href="/a" rel="nofollow noopener">A</a>`);
    expect(scan.links[0]!.rel).toBe("nofollow noopener");
  });

  it("❗ 링크가 상한을 넘으면 자르고 잘렸다고 표시한다", () => {
    const many = Array.from({ length: 500 }, (_, i) => `<a href="/p${i}">${i}</a>`).join("");
    const scan = scanHtml(`<body>${many}</body>`);
    expect(scan.linkCount).toBe(500);
    expect(scan.links.length).toBe(400);
    expect(scan.linksTruncated).toBe(true);
  });
});

describe("본문 대조 (contains)", () => {
  const scan = scanHtml(`<body><p>서울특별시 강남구 테헤란로 1길</p></body>`);

  it("알고 있는 문자열의 존재만 알려 준다", () => {
    expect(scan.contains("강남구")).toBe(true);
    expect(scan.contains("서초구")).toBe(false);
  });

  it("공백과 대소문자를 무시한다", () => {
    expect(scan.contains("강남 구")).toBe(true);
    expect(scanHtml("<p>Gangnam Clinic</p>").contains("gangnamclinic")).toBe(true);
  });

  it("빈 문자열은 항상 거짓이다 (모든 페이지가 매칭되는 것 방지)", () => {
    expect(scan.contains("")).toBe(false);
    expect(scan.contains("   ")).toBe(false);
  });

  it("❗ 스캔 결과에 본문 텍스트 자체가 들어 있지 않다", () => {
    // 이메일이 본문에 있어도 구조체 밖으로 나갈 통로가 없어야 한다 (제50조의2).
    const withEmail = scanHtml(`<body><p>문의: help(at)example.kr 로 연락 주세요</p></body>`);
    const serialized = JSON.stringify(withEmail);
    expect(serialized).not.toContain("example.kr");
    expect(serialized).not.toContain("연락 주세요");
  });
});

describe("폼·길이", () => {
  it("폼 개수를 센다", () => {
    expect(scanHtml(`<form></form><form></form>`).formCount).toBe(2);
  });

  it("껍데기 페이지는 텍스트 길이가 짧다", () => {
    expect(scanHtml(`<body><h1>준비중</h1></body>`).textLength).toBeLessThan(20);
  });
});

describe("깨진 마크업", () => {
  it("닫히지 않은 태그가 있어도 던지지 않는다", () => {
    expect(() => scanHtml(`<div><p>열림<a href="/a">링크<span></div>`)).not.toThrow();
  });

  it("빈 문서도 처리한다", () => {
    const scan = scanHtml("");
    expect(scan.links).toEqual([]);
    expect(scan.textLength).toBe(0);
    expect(scan.hasNoindex).toBe(false);
  });
});
