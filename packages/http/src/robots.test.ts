import { describe, expect, it } from "vitest";
import { decideFromCache, isAllowed, parseRobotsTxt } from "./robots";

const UA = "LeadOpsBot";

describe("parseRobotsTxt", () => {
  it("그룹·주석·빈 줄을 처리한다", () => {
    const r = parseRobotsTxt(`
      # 주석
      User-agent: *
      Disallow: /admin/
      Allow: /admin/public/

      Sitemap: https://example.kr/sitemap.xml
    `);
    expect(r.groups.get("*")).toEqual([
      { type: "disallow", pattern: "/admin/" },
      { type: "allow", pattern: "/admin/public/" },
    ]);
    expect(r.sitemaps).toEqual(["https://example.kr/sitemap.xml"]);
  });

  it("연속된 user-agent 줄을 하나의 그룹으로 묶는다", () => {
    const r = parseRobotsTxt("User-agent: a\nUser-agent: b\nDisallow: /x");
    expect(r.groups.get("a")).toEqual([{ type: "disallow", pattern: "/x" }]);
    expect(r.groups.get("b")).toEqual([{ type: "disallow", pattern: "/x" }]);
  });

  it("규칙 뒤의 user-agent 는 새 그룹을 시작한다", () => {
    const r = parseRobotsTxt("User-agent: a\nDisallow: /x\nUser-agent: b\nDisallow: /y");
    expect(r.groups.get("a")).toEqual([{ type: "disallow", pattern: "/x" }]);
    expect(r.groups.get("b")).toEqual([{ type: "disallow", pattern: "/y" }]);
  });

  it("빈 Disallow 는 규칙으로 취급하지 않는다 (전면 허용 의미)", () => {
    const r = parseRobotsTxt("User-agent: *\nDisallow:");
    expect(r.groups.get("*")).toEqual([]);
  });

  it("crawl-delay 를 읽는다", () => {
    const r = parseRobotsTxt("User-agent: *\nCrawl-delay: 5");
    expect(r.crawlDelaySec.get("*")).toBe(5);
  });
});

describe("isAllowed", () => {
  const r = parseRobotsTxt(`
    User-agent: *
    Disallow: /admin/
    Disallow: /*.pdf$
    Allow: /admin/public/

    User-agent: LeadOpsBot
    Disallow: /private/
  `);

  it("자기 user-agent 그룹이 있으면 그것만 적용한다", () => {
    // LeadOpsBot 그룹에는 /admin/ 규칙이 없다 → 허용
    expect(isAllowed(r, UA, "/admin/x").allowed).toBe(true);
    expect(isAllowed(r, UA, "/private/x").allowed).toBe(false);
  });

  it("해당 그룹이 없으면 * 그룹을 적용한다", () => {
    expect(isAllowed(r, "OtherBot", "/admin/x").allowed).toBe(false);
    expect(isAllowed(r, "OtherBot", "/public/x").allowed).toBe(true);
  });

  it("최장 일치가 이긴다 (Allow 가 더 구체적이면 허용)", () => {
    expect(isAllowed(r, "OtherBot", "/admin/public/a.html").allowed).toBe(true);
  });

  it("$ 로 끝나는 패턴을 처리한다", () => {
    expect(isAllowed(r, "OtherBot", "/docs/manual.pdf").allowed).toBe(false);
    expect(isAllowed(r, "OtherBot", "/docs/manual.pdf.html").allowed).toBe(true);
  });

  it("규칙이 전혀 없으면 허용한다", () => {
    expect(isAllowed(parseRobotsTxt(""), UA, "/anything").allowed).toBe(true);
  });

  it("전면 차단 robots 를 존중한다", () => {
    const deny = parseRobotsTxt("User-agent: *\nDisallow: /");
    expect(isAllowed(deny, UA, "/").allowed).toBe(false);
    expect(isAllowed(deny, UA, "/contact").allowed).toBe(false);
  });
});

describe("crawl-delay 는 선택된 그룹의 키로 조회한다", () => {
  it("❗ UA 토큰이 아니라 매칭된 그룹 이름으로 delay 를 찾는다", () => {
    const r = parseRobotsTxt("User-agent: LeadOpsBot\nDisallow: /x\nCrawl-delay: 7");
    // UA 토큰은 "LeadOpsBot/1.0" 이지만 그룹 키는 "leadopsbot" 이다.
    expect(isAllowed(r, "LeadOpsBot/1.0", "/ok").crawlDelaySec).toBe(7);
  });

  it("그룹에 delay 가 없으면 * 그룹의 값을 쓴다", () => {
    const r = parseRobotsTxt("User-agent: *\nCrawl-delay: 3\n\nUser-agent: LeadOpsBot\nDisallow: /x");
    expect(isAllowed(r, "LeadOpsBot/1.0", "/ok").crawlDelaySec).toBe(3);
  });

  it("* 그룹만 있으면 * 의 delay 를 쓴다", () => {
    const r = parseRobotsTxt("User-agent: *\nCrawl-delay: 5");
    expect(isAllowed(r, "OtherBot", "/ok").crawlDelaySec).toBe(5);
  });
});

describe("ReDoS 방어", () => {
  it("연속 와일드카드를 접어 중첩 백트래킹을 만들지 않는다", () => {
    const r = parseRobotsTxt("User-agent: *\nDisallow: /a**********b");
    expect(isAllowed(r, UA, "/a" + "x".repeat(50) + "b").allowed).toBe(false);
  });

  it("❗ 병적인 패턴에도 매칭이 빠르게 끝난다", () => {
    const evil = "/" + "*a".repeat(40) + "$";
    const r = parseRobotsTxt(`User-agent: *\nDisallow: ${evil}`);
    const path = "/" + "a".repeat(4000) + "b";
    const t0 = performance.now();
    isAllowed(r, UA, path);
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it("와일드카드 상한을 넘는 규칙은 무시하고 다른 규칙이 판단한다", () => {
    const tooMany = "/" + "*x".repeat(30);
    const r = parseRobotsTxt(`User-agent: *\nDisallow: ${tooMany}\nDisallow: /admin/`);
    expect(isAllowed(r, UA, "/admin/a").allowed).toBe(false); // 정상 규칙은 살아 있다
    expect(isAllowed(r, UA, "/x").allowed).toBe(true); // 병적인 규칙은 무시됐다
  });

  it("지나치게 긴 패턴도 무시한다", () => {
    const r = parseRobotsTxt(`User-agent: *\nDisallow: /${"a".repeat(600)}`);
    expect(isAllowed(r, UA, "/" + "a".repeat(600)).allowed).toBe(true);
  });
});

describe("decideFromCache — 조회 실패 시 정책", () => {
  it("404 는 robots 가 없는 것이므로 전면 허용한다", () => {
    expect(decideFromCache({ robots: null, failure: "not_found", fetchedAt: 0 }, UA, "/x").allowed).toBe(true);
  });

  it("네트워크 오류는 fail-closed 로 차단한다", () => {
    expect(decideFromCache({ robots: null, failure: "fetch_error", fetchedAt: 0 }, UA, "/x").allowed).toBe(false);
  });

  it("robots 가 너무 크면 차단한다", () => {
    expect(decideFromCache({ robots: null, failure: "too_large", fetchedAt: 0 }, UA, "/x").allowed).toBe(false);
  });
});
