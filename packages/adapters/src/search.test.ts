import { describe, expect, it } from "vitest";
import { MAX_DISPLAY, parseHitDate, parseNaverResponse, stripHighlight } from "./search";

/**
 * 네이버 검색 응답 해석.
 *
 * ⚠️ **이 어댑터는 실 API 로 검증되지 않았다.** 자격증명이 없어 응답 형태를 실측하지
 *    못했고, 아래 fixture 는 네이버 개발자 문서를 근거로 만든 것이다. 키가 생기면
 *    실응답을 녹화해 이 fixture 를 교체해야 한다. 그 전까지 ORS 를 확정으로 다루지 않는다.
 */

const BLOG_RESPONSE = JSON.stringify({
  lastBuildDate: "Wed, 30 Jul 2026 09:00:00 +0900",
  total: 1234,
  start: 1,
  display: 2,
  items: [
    {
      title: "<b>강남 피부과</b> 여드름 후기",
      link: "https://blog.naver.com/someone/222",
      description: "<b>강남</b> 다녀왔어요",
      bloggername: "someone",
      bloggerlink: "https://blog.naver.com/someone",
      postdate: "20260715",
    },
    {
      title: "라온피부과 공식 안내",
      link: "https://raon-derm.co.kr/notice/1",
      description: "진료 안내",
      postdate: "20260701",
    },
  ],
});

describe("응답 해석", () => {
  it("total 과 items 를 읽는다", () => {
    const result = parseNaverResponse("blog", "강남 피부과", BLOG_RESPONSE);
    expect(result.total).toBe(1234);
    expect(result.hits.length).toBe(2);
    expect(result.hits[0]!.rank).toBe(1);
  });

  it("❗ 강조 태그를 벗긴다 (그대로 저장하면 stored XSS 경로가 된다)", () => {
    const result = parseNaverResponse("blog", "강남 피부과", BLOG_RESPONSE);
    expect(result.hits[0]!.title).toBe("강남 피부과 여드름 후기");
    expect(result.hits[0]!.title).not.toContain("<b>");
  });

  it("출처 블로그 주소를 남긴다 (공식 채널 대조용)", () => {
    const result = parseNaverResponse("blog", "강남 피부과", BLOG_RESPONSE);
    expect(result.hits[0]!.sourceUrl).toBe("https://blog.naver.com/someone");
  });

  it("link 가 없는 항목은 버린다", () => {
    const body = JSON.stringify({ total: 2, items: [{ title: "a" }, { title: "b", link: "https://x.kr" }] });
    expect(parseNaverResponse("webkr", "k", body).hits.length).toBe(1);
  });
});

describe("❗ fail-open 금지", () => {
  it("JSON 이 아니면 던진다", () => {
    expect(() => parseNaverResponse("blog", "k", "<html>error</html>")).toThrow(/JSON/);
  });

  it("total·items 가 없으면 0건이 아니라 에러다", () => {
    // 조용히 0건으로 처리하면 모든 업체가 "콘텐츠 없음" 으로 보인다.
    expect(() => parseNaverResponse("blog", "k", JSON.stringify({ ok: true }))).toThrow(/total/);
  });

  it("errorCode 가 오면 던진다", () => {
    const body = JSON.stringify({ errorCode: "024", errorMessage: "Not Exist Client ID" });
    expect(() => parseNaverResponse("blog", "k", body)).toThrow(/Not Exist Client ID/);
  });

  it("배열이나 null 응답도 거부한다", () => {
    expect(() => parseNaverResponse("blog", "k", "null")).toThrow();
    expect(() => parseNaverResponse("blog", "k", "[]")).toThrow(/total/);
  });

  it("결과가 정말 0건이면 정상 처리한다", () => {
    const result = parseNaverResponse("blog", "k", JSON.stringify({ total: 0, items: [] }));
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
  });
});

describe("날짜 파싱", () => {
  it("블로그의 YYYYMMDD 를 읽는다", () => {
    expect(parseHitDate("20260715")?.toISOString().slice(0, 10)).toBe("2026-07-15");
  });

  it("뉴스의 RFC822 를 읽는다", () => {
    expect(parseHitDate("Tue, 15 Jul 2026 10:00:00 +0900")?.toISOString().slice(0, 10)).toBe("2026-07-15");
  });

  it("읽을 수 없으면 undefined 다", () => {
    expect(parseHitDate("")).toBeUndefined();
    expect(parseHitDate("알 수 없음")).toBeUndefined();
    expect(parseHitDate(undefined)).toBeUndefined();
    expect(parseHitDate("00000000")).toBeUndefined();
  });
});

describe("HTML 엔티티", () => {
  it("엔티티를 되돌린다", () => {
    expect(stripHighlight("A &amp; B &lt;C&gt; &quot;D&quot;")).toBe('A & B <C> "D"');
  });

  it("문자열이 아니면 빈 문자열이다", () => {
    expect(stripHighlight(undefined)).toBe("");
    expect(stripHighlight(123)).toBe("");
  });
});

describe("채널별 상한 (설계서 3.1)", () => {
  it("local 만 5 이고 나머지는 100 이다", () => {
    expect(MAX_DISPLAY.local).toBe(5);
    for (const p of ["blog", "cafearticle", "webkr", "news"] as const) {
      expect(MAX_DISPLAY[p]).toBe(100);
    }
  });
});
