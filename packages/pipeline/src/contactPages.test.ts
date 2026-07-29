import { describe, expect, it } from "vitest";
import { detectContactPages } from "./contactPages";
import { scanHtml } from "./html";

/**
 * 연락처 페이지 후보 탐지.
 *
 * 이 파일의 가장 중요한 테스트는 `mailto:` 거부다. mailto href 는 그 자체가
 * 이메일 주소이므로 후보로 저장하면 "홈페이지에서 이메일 자동 수집" 이 된다
 * (정보통신망법 제50조의2 · 설계서 결론 A).
 */

const BASE = "https://raon-derm.co.kr/";
const detect = (html: string, base = BASE) => detectContactPages(scanHtml(html).links, base);

describe("❗ 이메일이 될 수 있는 링크는 후보가 되지 않는다", () => {
  it("mailto: 링크를 버린다", () => {
    const found = detect(`<a href="mailto:info@raon-derm.co.kr">이메일 문의</a>`);
    expect(found).toEqual([]);
  });

  it("mailto: 가 다른 후보와 섞여 있어도 그것만 빠진다", () => {
    const found = detect(`
      <a href="mailto:help@raon-derm.co.kr">이메일 문의</a>
      <a href="/contact">문의하기</a>`);
    expect(found.map((c) => c.url)).toEqual(["https://raon-derm.co.kr/contact"]);
  });

  it("어떤 후보의 URL 에도 @ 가 남지 않는다", () => {
    const found = detect(`
      <a href="mailto:a@b.kr?subject=문의">문의</a>
      <a href="MAILTO:c@d.kr">연락처</a>
      <a href="/contact">오시는 길</a>`);
    for (const c of found) expect(c.url).not.toContain("@");
  });

  it("tel · javascript · data 스킴도 버린다", () => {
    const found = detect(`
      <a href="tel:021234567">문의</a>
      <a href="javascript:openContact()">문의</a>
      <a href="data:text/html,contact">문의</a>`);
    expect(found).toEqual([]);
  });
});

describe("유형 분류", () => {
  it("앵커 텍스트로 유형을 정한다", () => {
    const found = detect(`
      <a href="/p1">오시는 길</a>
      <a href="/p2">회사소개</a>
      <a href="/p3">개인정보처리방침</a>
      <a href="/p4">이용약관</a>
      <a href="/p5">제휴문의</a>`);
    const byUrl = new Map(found.map((c) => [c.url, c.pageKind]));
    expect(byUrl.get("https://raon-derm.co.kr/p1")).toBe("contact");
    expect(byUrl.get("https://raon-derm.co.kr/p2")).toBe("about");
    expect(byUrl.get("https://raon-derm.co.kr/p3")).toBe("privacy");
    expect(byUrl.get("https://raon-derm.co.kr/p4")).toBe("terms");
    expect(byUrl.get("https://raon-derm.co.kr/p5")).toBe("partnership");
  });

  it("앵커 텍스트가 없으면 URL 경로로 정한다", () => {
    const found = detect(`<a href="/contact"><img src="/i.png"></a>`);
    expect(found[0]!.pageKind).toBe("contact");
  });

  it("쿼리스트링 라우팅도 잡는다", () => {
    const found = detect(`<a href="/bbs/board.php?bo_table=contact">.</a>`);
    expect(found[0]?.pageKind).toBe("contact");
  });

  it("영문 사이트도 분류한다", () => {
    const found = detect(`<a href="/x">Contact Us</a><a href="/y">About</a>`);
    expect(found.map((c) => c.pageKind).sort()).toEqual(["about", "contact"]);
  });

  it("연락처와 무관한 링크는 후보가 아니다", () => {
    const found = detect(`<a href="/notice">공지사항</a><a href="/price">비용안내</a>`);
    expect(found).toEqual([]);
  });
});

describe("URL 처리", () => {
  it("상대 경로를 절대 URL 로 만든다", () => {
    const found = detect(`<a href="sub/contact">문의</a>`, "https://raon-derm.co.kr/kr/index.html");
    expect(found[0]!.url).toBe("https://raon-derm.co.kr/kr/sub/contact");
  });

  it("fragment 는 제거하고 같은 페이지로 합친다", () => {
    const found = detect(`<a href="/contact#top">문의</a><a href="/contact#form">오시는 길</a>`);
    expect(found.length).toBe(1);
    expect(found[0]!.url).toBe("https://raon-derm.co.kr/contact");
  });

  it("❗ 외부 사이트의 연락처 페이지는 이 업체 것이 아니다", () => {
    const found = detect(`
      <a href="https://other-clinic.co.kr/contact">문의</a>
      <a href="https://www.instagram.com/x/about">회사소개</a>`);
    expect(found).toEqual([]);
  });

  it("서브도메인은 같은 사이트로 본다", () => {
    const found = detect(`<a href="https://m.raon-derm.co.kr/contact">문의</a>`);
    expect(found.length).toBe(1);
  });

  it("www 유무는 같은 사이트다", () => {
    const found = detect(`<a href="https://www.raon-derm.co.kr/contact">문의</a>`);
    expect(found.length).toBe(1);
  });

  it("#만 있는 링크와 빈 href 는 무시한다", () => {
    const found = detect(`<a href="#">문의</a><a href="">문의</a>`);
    expect(found).toEqual([]);
  });
});

describe("우선순위와 상한", () => {
  it("같은 URL 이 여러 앵커로 걸리면 신뢰도 높은 유형을 남긴다", () => {
    const found = detect(`<a href="/c">이용약관</a><a href="/c">제휴문의</a>`);
    expect(found.length).toBe(1);
    expect(found[0]!.pageKind).toBe("partnership");
  });

  it("신뢰도 내림차순으로 돌려준다", () => {
    const found = detect(`
      <a href="/t">이용약관</a>
      <a href="/c">문의</a>
      <a href="/p">제휴</a>`);
    expect(found.map((c) => c.pageKind)).toEqual(["partnership", "contact", "terms"]);
    expect(found[0]!.confidence).toBeGreaterThan(found[2]!.confidence);
  });

  it("후보 수에 상한이 있다", () => {
    const many = Array.from({ length: 40 }, (_, i) => `<a href="/c${i}">문의${i}</a>`).join("");
    expect(detect(many).length).toBeLessThanOrEqual(12);
  });

  it("잘못된 base URL 이면 빈 결과를 준다 (던지지 않는다)", () => {
    expect(detectContactPages([{ href: "/contact", text: "문의" }], "not-a-url")).toEqual([]);
  });
});
