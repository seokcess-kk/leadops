import { describe, expect, it } from "vitest";
import { describeChannel, discoverChannels } from "./channels";
import { scanHtml } from "./html";

/**
 * 공식 채널 발견.
 *
 * 검색으로 찾지 않고 **공식 홈페이지가 스스로 링크한 주소만** 인정한다.
 * 검색으로 찾으면 동명이인·팬페이지를 공식으로 오인하고 네이버 쿼터도 쓴다.
 */

const BASE = "https://raon-derm.co.kr/";
const find = (html: string) => discoverChannels(scanHtml(html).links, BASE);

describe("블로그", () => {
  it("네이버 블로그를 찾고 RSS 주소를 만든다", () => {
    const [ch] = find(`<a href="https://blog.naver.com/raonderm">공식 블로그</a>`);
    expect(ch).toMatchObject({
      type: "official_blog",
      platform: "naver_blog",
      handle: "raonderm",
      url: "https://blog.naver.com/raonderm",
      analyzable: true,
      feedUrl: "https://rss.blog.naver.com/raonderm.xml",
    });
  });

  it("모바일·쿼리 형태도 같은 채널로 본다", () => {
    const found = find(`
      <a href="https://m.blog.naver.com/raonderm">모바일</a>
      <a href="https://blog.naver.com/PostList.naver?blogId=raonderm">목록</a>`);
    expect(found.length).toBe(1);
    expect(found[0]!.handle).toBe("raonderm");
  });

  it("티스토리 RSS 주소를 만든다", () => {
    const [ch] = find(`<a href="https://raonderm.tistory.com/">블로그</a>`);
    expect(ch).toMatchObject({ platform: "tistory", feedUrl: "https://raonderm.tistory.com/rss" });
  });

  it("❗ 브런치는 피드 규칙을 검증하지 못해 분석하지 않는다", () => {
    // 추측한 주소로 요청을 보내지 않는다 — 존재는 기록하되 분석은 포기한다.
    const [ch] = find(`<a href="https://brunch.co.kr/@raonderm">브런치</a>`);
    expect(ch!.analyzable).toBe(false);
    expect(ch!.unavailableReason).toBe("brunch_feed_unverified");
    expect(ch!.feedUrl).toBeUndefined();
  });
});

describe("유튜브", () => {
  it("channel_id 가 있으면 공개 피드로 분석한다 (Data API 불필요)", () => {
    const id = "UC1234567890abcdefghijkl";
    const [ch] = find(`<a href="https://www.youtube.com/channel/${id}">유튜브</a>`);
    expect(ch).toMatchObject({
      type: "official_video",
      analyzable: true,
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
    });
  });

  it("❗ 핸들 주소는 channel_id 를 알 수 없어 분석하지 못한다", () => {
    const [ch] = find(`<a href="https://www.youtube.com/@raonderm">유튜브</a>`);
    expect(ch!.analyzable).toBe(false);
    expect(ch!.unavailableReason).toBe("youtube_handle_needs_resolution");
  });

  it("구형 /c/ · /user/ 주소도 분석 대상이 아니다", () => {
    expect(find(`<a href="https://www.youtube.com/c/RaonDerm">y</a>`)[0]!.analyzable).toBe(false);
    expect(find(`<a href="https://www.youtube.com/user/raon">y</a>`)[0]!.analyzable).toBe(false);
  });

  it("잘못된 channel_id 형식은 채널로 잡지 않는다", () => {
    expect(find(`<a href="https://www.youtube.com/channel/not-a-real-id">y</a>`)).toEqual([]);
  });

  it("동영상 링크는 채널이 아니다", () => {
    expect(find(`<a href="https://www.youtube.com/watch?v=abc123">영상</a>`)).toEqual([]);
  });
});

describe("SNS · 플레이스", () => {
  it("존재는 기록하되 공개 피드가 없어 분석하지 않는다", () => {
    const found = find(`
      <a href="https://www.instagram.com/raonderm/">인스타</a>
      <a href="https://www.facebook.com/raonderm">페이스북</a>`);
    expect(found.length).toBe(2);
    for (const ch of found) {
      expect(ch.type).toBe("official_sns");
      expect(ch.analyzable).toBe(false);
    }
  });

  it("플랫폼 홈 링크는 채널이 아니다", () => {
    expect(find(`<a href="https://www.instagram.com/">인스타그램</a>`)).toEqual([]);
  });

  it("플레이스는 등록 신호로만 쓴다", () => {
    const [ch] = find(`<a href="https://place.naver.com/hospital/12345">플레이스</a>`);
    expect(ch).toMatchObject({ type: "place", analyzable: false });
  });
});

describe("수집 범위", () => {
  it("관계없는 링크는 채널이 아니다", () => {
    expect(find(`<a href="/about">소개</a><a href="https://google.com">구글</a>`)).toEqual([]);
  });

  it("mailto · tel 은 무시한다", () => {
    expect(find(`<a href="mailto:a@b.kr">메일</a><a href="tel:021234567">전화</a>`)).toEqual([]);
  });

  it("채널 수에 상한이 있다", () => {
    const many = Array.from({ length: 30 }, (_, i) => `<a href="https://blog.naver.com/b${i}">b</a>`).join("");
    expect(find(many).length).toBeLessThanOrEqual(12);
  });

  it("잘못된 base URL 이면 빈 결과다", () => {
    expect(discoverChannels([{ href: "https://blog.naver.com/x", text: "b" }], "nope")).toEqual([]);
  });
});

describe("저장된 URL 재해석", () => {
  it("DB 의 url 만으로 피드 주소를 다시 만든다", () => {
    const ch = describeChannel("https://blog.naver.com/raonderm");
    expect(ch?.feedUrl).toBe("https://rss.blog.naver.com/raonderm.xml");
  });

  it("알아보지 못하는 주소는 undefined 다", () => {
    expect(describeChannel("https://example.com/blog")).toBeUndefined();
    expect(describeChannel("깨진주소")).toBeUndefined();
  });
});
