import type { SearchResult } from "@leadops/adapters";
import { describe, expect, it } from "vitest";
import { aggregateAll, aggregateChannel, canonicalHitUrl, hashUrl, recencyOf, type OrsContext } from "./ors";

/**
 * ORS — Open-API Result Share.
 *
 * ❗ 이 테스트가 지키는 것은 **과장하지 않는 것**이다. ORS 는 검색 순위도 노출 점유율도
 *    아니고, 분모를 잘못 잡으면 없는 공백을 만들어 낸다.
 */

const NOW = new Date("2026-07-30T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000);

const ctx: OrsContext = {
  companyName: "라온피부과의원",
  officialDomains: ["raon-derm.co.kr"],
  officialChannelUrls: ["https://blog.naver.com/raonderm"],
  now: NOW,
};

function result(total: number, links: string[], provider: SearchResult["provider"] = "blog"): SearchResult {
  return {
    provider,
    keyword: "강남 피부과",
    total,
    hits: links.map((link, i) => ({
      rank: i + 1,
      title: `글 ${i + 1}`,
      link,
      description: "",
      publishedAt: daysAgo(i * 10),
    })),
  };
}

describe("분모 (R2-09)", () => {
  it("결과가 30건 넘으면 30 으로 자른다", () => {
    const links = Array.from({ length: 40 }, (_, i) => `https://other.kr/${i}`);
    expect(aggregateChannel(result(1200, links), ctx).denominator).toBe(30);
  });

  it("❗ 결과가 적은 채널을 고정 30 으로 깎지 않는다", () => {
    // v2 의 고정 30 은 실제 10건인 채널을 부당하게 낮게 평가했다.
    const links = Array.from({ length: 10 }, (_, i) => `https://other.kr/${i}`);
    const agg = aggregateChannel(result(10, links), ctx);
    expect(agg.denominator).toBe(10);
  });

  it("❗ 보지 못한 결과를 분모에 넣지 않는다", () => {
    // API 가 total 은 크게 보고하면서 항목은 적게 주는 경우가 있다.
    const agg = aggregateChannel(result(500, ["https://other.kr/1", "https://other.kr/2"]), ctx);
    expect(agg.denominator).toBe(2);
  });

  it("❗ 결과가 0건이면 ORS 는 0 이 아니라 정의되지 않음이다", () => {
    const agg = aggregateChannel(result(0, []), ctx);
    expect(agg.denominator).toBe(0);
    expect(agg.ors).toBeNull();
    expect(agg.totalReturned).toBe(0);
  });
});

describe("공식 여부 판정", () => {
  it("공식 도메인의 결과를 공식으로 센다", () => {
    const agg = aggregateChannel(
      result(3, ["https://raon-derm.co.kr/blog/1", "https://other.kr/a", "https://other.kr/b"]),
      ctx,
    );
    expect(agg.officialCount).toBe(1);
    expect(agg.ors).toBeCloseTo(1 / 3, 4);
  });

  it("서브도메인도 공식이다", () => {
    const agg = aggregateChannel(result(1, ["https://m.raon-derm.co.kr/x"]), ctx);
    expect(agg.officialCount).toBe(1);
  });

  it("❗ 공유 호스트의 남의 블로그를 공식으로 오인하지 않는다", () => {
    // blog.naver.com 은 수백만 명이 쓰는 호스트다. 경로까지 봐야 한다.
    const agg = aggregateChannel(
      result(2, ["https://blog.naver.com/raonderm/100", "https://blog.naver.com/someone-else/1"]),
      ctx,
    );
    expect(agg.officialCount).toBe(1);
    expect(agg.hits[0]!.isOfficial).toBe(true);
    expect(agg.hits[1]!.isOfficial).toBe(false);
  });

  it("상호가 언급되면 공식이 아니어도 related 다", () => {
    const raw = result(2, ["https://other.kr/a", "https://other.kr/b"]);
    const withBrand: SearchResult = {
      ...raw,
      hits: [{ ...raw.hits[0]!, title: "라온피부과의원 다녀온 후기" }, raw.hits[1]!],
    };
    const agg = aggregateChannel(withBrand, ctx);
    expect(agg.relatedCount).toBe(1);
    expect(agg.officialCount).toBe(0);
  });

  it("공식은 언제나 related 에도 포함된다", () => {
    const agg = aggregateChannel(result(1, ["https://raon-derm.co.kr/a"]), ctx);
    expect(agg.relatedCount).toBe(1);
    expect(agg.officialCount).toBe(1);
  });
});

describe("채널 유형", () => {
  it("공식 여부에 따라 유형이 갈린다", () => {
    const agg = aggregateChannel(
      result(2, ["https://raon-derm.co.kr/a", "https://other.kr/b"]),
      ctx,
    );
    expect(agg.hits[0]!.channelType).toBe("official_site");
    expect(agg.hits[1]!.channelType).toBe("thirdparty_blog");
  });

  it("❗ 유형은 회수된 인덱스가 아니라 URL 로 정한다", () => {
    // 같은 blog 인덱스에서 나와도 자기 도메인이면 official_site, 블로그 플랫폼이면 official_blog 다.
    const agg = aggregateChannel(
      result(2, ["https://raon-derm.co.kr/post/1", "https://blog.naver.com/raonderm/1"], "blog"),
      ctx,
    );
    expect(agg.hits[0]!.channelType).toBe("official_site");
    expect(agg.hits[1]!.channelType).toBe("official_blog");
  });

  it("채널별 기본 유형을 매긴다", () => {
    expect(aggregateChannel(result(1, ["https://x.kr/a"], "cafearticle"), ctx).hits[0]!.channelType)
      .toBe("cafe");
    expect(aggregateChannel(result(1, ["https://x.kr/a"], "news"), ctx).hits[0]!.channelType).toBe("news");
    expect(aggregateChannel(result(1, ["https://x.kr/a"], "webkr"), ctx).hits[0]!.channelType).toBe("webdoc");
  });
});

describe("URL 정규화와 중복", () => {
  it("모바일·www·추적 파라미터를 같은 것으로 본다", () => {
    expect(canonicalHitUrl("https://m.blog.naver.com/x/1?utm_source=a"))
      .toBe(canonicalHitUrl("https://blog.naver.com/x/1"));
  });

  it("후행 슬래시를 무시한다", () => {
    expect(hashUrl("https://a.kr/b/")).toBe(hashUrl("https://a.kr/b"));
  });

  it("같은 채널 응답 안의 중복 URL 을 한 건으로 센다", () => {
    const agg = aggregateChannel(result(3, ["https://a.kr/1", "https://a.kr/1/", "https://a.kr/2"]), ctx);
    expect(agg.hits.length).toBe(2);
  });

  it("❗ 채널 간 중복은 먼저 본 채널에만 남긴다", () => {
    const blog = result(2, ["https://shared.kr/1", "https://blogonly.kr/1"], "blog");
    const web = result(2, ["https://shared.kr/1", "https://webonly.kr/1"], "webkr");
    const { aggregates, dedupedHits } = aggregateAll([blog, web], ctx);

    expect(dedupedHits.length).toBe(3);
    // 채널별 집계 수치는 각자의 응답 기준이다 — 중복을 이유로 깎지 않는다.
    expect(aggregates[0]!.denominator).toBe(2);
    expect(aggregates[1]!.denominator).toBe(2);
  });
});

describe("최근성", () => {
  it("발행일을 구간으로 나눈다", () => {
    expect(recencyOf(daysAgo(10), NOW)).toBe("d0_60");
    expect(recencyOf(daysAgo(90), NOW)).toBe("d61_120");
    expect(recencyOf(daysAgo(300), NOW)).toBe("d120_plus");
    expect(recencyOf(undefined, NOW)).toBe("unknown");
  });

  it("미래 날짜는 unknown 이다", () => {
    expect(recencyOf(new Date(NOW.getTime() + 86_400_000), NOW)).toBe("unknown");
  });

  it("분포의 합이 분모와 같다", () => {
    const links = Array.from({ length: 5 }, (_, i) => `https://a.kr/${i}`);
    const agg = aggregateChannel(result(5, links), ctx);
    const sum = Object.values(agg.recencyDist).reduce((a, b) => a + b, 0);
    expect(sum).toBe(agg.denominator);
  });
});

describe("❗ 짧은 상호의 오탐 방지", () => {
  it("두 글자 상호로는 related 를 판정하지 않는다", () => {
    const shortCtx: OrsContext = { ...ctx, companyName: "온", officialDomains: [], officialChannelUrls: [] };
    const raw = result(1, ["https://other.kr/a"]);
    const withText: SearchResult = { ...raw, hits: [{ ...raw.hits[0]!, title: "온천 여행기" }] };
    expect(aggregateChannel(withText, shortCtx).relatedCount).toBe(0);
  });
});
