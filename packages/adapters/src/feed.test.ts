import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed";

/**
 * 피드 파서.
 *
 * 실제 국내 블로그 피드는 RSS 2.0(네이버·티스토리)과 Atom(유튜브)이 대부분이고,
 * 오래된 설치형 블로그에서 RSS 1.0(RDF)이 나온다. 셋 다 처리해야 한다.
 */

const NOW = new Date("2026-07-30T00:00:00Z");

describe("RSS 2.0", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      <title>라온피부과 공식블로그</title>
      <item><title>여드름 관리법</title><pubDate>Mon, 15 Jul 2026 10:00:00 +0900</pubDate></item>
      <item><title>7월 이벤트 안내</title><pubDate>Tue, 01 Jul 2026 09:00:00 +0900</pubDate></item>
    </channel></rss>`;

  it("제목과 발행일을 읽는다", () => {
    const feed = parseFeed(xml, NOW);
    expect(feed.title).toBe("라온피부과 공식블로그");
    expect(feed.entries.length).toBe(2);
    expect(feed.entries[0]!.title).toBe("여드름 관리법");
    expect(feed.entries[0]!.publishedAt?.toISOString().slice(0, 10)).toBe("2026-07-15");
  });

  it("항목이 하나뿐이어도 배열로 다룬다", () => {
    const single = `<rss><channel><item><title>하나</title><pubDate>Mon, 15 Jul 2026 10:00:00 +0900</pubDate></item></channel></rss>`;
    expect(parseFeed(single, NOW).entries.length).toBe(1);
  });
});

describe("Atom (유튜브 피드 형태)", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
      <title>라온피부과</title>
      <entry><title>시술 소개</title><published>2026-07-20T09:00:00+00:00</published></entry>
      <entry><title>병원 둘러보기</title><published>2026-06-01T09:00:00+00:00</published></entry>
    </feed>`;

  it("entry 와 published 를 읽는다", () => {
    const feed = parseFeed(xml, NOW);
    expect(feed.title).toBe("라온피부과");
    expect(feed.entries.length).toBe(2);
    expect(feed.entries[0]!.publishedAt?.toISOString().slice(0, 10)).toBe("2026-07-20");
  });
});

describe("RSS 1.0 (RDF) · 네임스페이스", () => {
  it("dc:date 를 접두어 없이 읽는다", () => {
    const xml = `<?xml version="1.0"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel><title>구형 블로그</title></channel>
        <item><title>글 하나</title><dc:date>2026-07-10T00:00:00+09:00</dc:date></item>
      </rdf:RDF>`;
    const feed = parseFeed(xml, NOW);
    expect(feed.entries.length).toBe(1);
    expect(feed.entries[0]!.publishedAt?.toISOString().slice(0, 10)).toBe("2026-07-09");
  });
});

describe("❗ 신뢰할 수 없는 입력", () => {
  it("HTML 을 받으면 빈 결과다 (던지지 않는다)", () => {
    const feed = parseFeed("<html><body>Not Found</body></html>", NOW);
    expect(feed.entries).toEqual([]);
  });

  it("깨진 XML 도 던지지 않는다", () => {
    expect(() => parseFeed("<rss><channel><item>", NOW)).not.toThrow();
  });

  it("빈 문자열도 처리한다", () => {
    expect(parseFeed("", NOW).entries).toEqual([]);
  });

  it("❗ 미래 날짜는 신뢰하지 않는다 (예약 발행·서버 시계 오류)", () => {
    const xml = `<rss><channel><item><title>미래</title><pubDate>Fri, 01 Jan 2100 00:00:00 +0900</pubDate></item></channel></rss>`;
    const feed = parseFeed(xml, NOW);
    expect(feed.entries[0]!.publishedAt).toBeUndefined();
    expect(feed.undatedCount).toBe(1);
  });

  it("날짜를 못 읽은 항목을 센다", () => {
    const xml = `<rss><channel>
      <item><title>a</title><pubDate>Mon, 15 Jul 2026 10:00:00 +0900</pubDate></item>
      <item><title>b</title><pubDate>알 수 없음</pubDate></item>
      <item><title>c</title></item>
    </channel></rss>`;
    const feed = parseFeed(xml, NOW);
    expect(feed.entries.length).toBe(3);
    expect(feed.undatedCount).toBe(2);
  });

  it("항목 수에 상한이 있다", () => {
    const items = Array.from({ length: 400 }, (_, i) => `<item><title>${i}</title></item>`).join("");
    expect(parseFeed(`<rss><channel>${items}</channel></rss>`, NOW).entries.length).toBe(200);
  });
});

describe("❗ 본문을 다루지 않는다 (제50조의2)", () => {
  it("description·content 를 반환하지 않는다", () => {
    const xml = `<rss><channel><item>
      <title>문의 안내</title>
      <description>문의는 help(at)example.kr 로 주세요</description>
      <content:encoded xmlns:content="http://purl.org/rss/1.0/modules/content/">본문 전체</content:encoded>
      <pubDate>Mon, 15 Jul 2026 10:00:00 +0900</pubDate>
    </item></channel></rss>`;
    const serialized = JSON.stringify(parseFeed(xml, NOW));
    expect(serialized).not.toContain("example.kr");
    expect(serialized).not.toContain("본문 전체");
  });
});
