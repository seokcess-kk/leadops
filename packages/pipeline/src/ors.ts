import { createHash } from "node:crypto";
import type { OrsChannel, SearchHit, SearchResult } from "@leadops/adapters";
import { normalizeCompanyName } from "./normalize";

/**
 * ORS — Open-API Result Share (설계서 3절).
 *
 * ❗ 이름을 지키는 것이 중요하다. 이것은 **검색 순위도, 노출 점유율도 아니다.**
 *    네이버 Open API 가 채널별 독립 인덱스에서 돌려준 결과 중 그 업체의 콘텐츠가
 *    몇 건인지를 재는 값이다. UI·리포트에서 "노출·순위·점유율" 로 부르면 과장이다.
 *
 * 분모: 채널마다 `min(30, total, 실제 회수 건수)`.
 *   - 고정 30 을 쓰면 결과가 10건뿐인 채널을 부당하게 낮게 평가한다(R2-09).
 *   - 실제 회수 건수까지 넣는 이유: API 가 total 은 크게 보고하면서 항목은 적게 주는
 *     경우가 있는데, 보지 못한 결과를 분모에 넣으면 없는 공백을 만들어 낸다.
 *   - 분모가 0 이면 ORS 는 0 이 아니라 **정의되지 않음**이다. 아무도 콘텐츠가 없는
 *     키워드는 점유 공백을 재는 데 쓸 수 없다.
 *
 * 브랜드/비브랜드는 **합산하지 않는다**. 상호로 검색하면 당연히 본인 콘텐츠가 잡히므로
 * 섞으면 점유율이 부풀려진다(설계서 3절).
 */

export const ORS_DENOMINATOR_CAP = 30;

export type RecencyBucket = "d0_60" | "d61_120" | "d120_plus" | "unknown";

/** `channel_type` 열거형 중 검색 결과에 쓰는 값. */
export type HitChannelType =
  | "official_site"
  | "official_blog"
  | "official_video"
  | "thirdparty_blog"
  | "cafe"
  | "news"
  | "webdoc"
  | "unknown";

export interface ClassifiedHit {
  readonly rank: number;
  readonly url: string;
  readonly urlHash: string;
  readonly channelType: HitChannelType;
  readonly isOfficial: boolean;
  readonly isRelated: boolean;
  readonly recency: RecencyBucket;
  readonly title: string;
  readonly publishedAt?: Date | undefined;
}

export interface ChannelAggregate {
  readonly provider: OrsChannel;
  readonly totalReturned: number;
  readonly denominator: number;
  readonly relatedCount: number;
  readonly officialCount: number;
  /** 분모가 0 이면 null. */
  readonly ors: number | null;
  readonly recencyDist: Readonly<Record<RecencyBucket, number>>;
  readonly hits: readonly ClassifiedHit[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 중복 판정용 URL 정규화.
 *
 * 같은 글이 채널마다 다른 주소로 잡힌다 (`blog.naver.com/x/1` ↔ `m.blog.naver.com/x/1`).
 * 추적 파라미터도 떼어 낸다.
 */
export function canonicalHitUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|from|trackingcode)/i.test(key)) u.searchParams.delete(key);
    }
    const query = u.searchParams.toString();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${query ? `?${query}` : ""}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function hashUrl(raw: string): string {
  return createHash("sha256").update(canonicalHitUrl(raw)).digest("hex").slice(0, 32);
}

export function recencyOf(published: Date | undefined, now: Date): RecencyBucket {
  if (!published) return "unknown";
  const age = now.getTime() - published.getTime();
  if (age < 0) return "unknown";
  if (age <= 60 * DAY_MS) return "d0_60";
  if (age <= 120 * DAY_MS) return "d61_120";
  return "d120_plus";
}

export interface OrsContext {
  readonly companyName: string;
  /** 공식 홈페이지 도메인 (www 제거). */
  readonly officialDomains: readonly string[];
  /** 공식 채널 URL (블로그·유튜브 등). */
  readonly officialChannelUrls: readonly string[];
  readonly now?: Date;
}

/** 호스트가 공식 도메인이거나 그 서브도메인인가. */
function hostMatches(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^(www|m)\./, "");
  return domains.some((d) => {
    const target = d.toLowerCase().replace(/^www\./, "");
    return h === target || h.endsWith(`.${target}`);
  });
}

/** 공식 채널 URL 은 경로까지 봐야 한다 — `blog.naver.com` 은 공유 호스트다. */
function channelMatches(link: string, channelUrls: readonly string[]): boolean {
  const canonical = canonicalHitUrl(link);
  return channelUrls.some((c) => {
    const target = canonicalHitUrl(c);
    return target.length > 0 && (canonical === target || canonical.startsWith(`${target}/`));
  });
}

/** 블로그 플랫폼 호스트. 공식 결과의 유형을 가르는 기준이다. */
const BLOG_HOSTS = /(^|\.)(blog\.naver\.com|blog\.me|tistory\.com|brunch\.co\.kr|blogspot\.com)$/i;

function channelTypeFor(provider: OrsChannel, isOfficial: boolean, link: string): HitChannelType {
  if (isOfficial) {
    // ❗ 유형은 **URL** 로 정한다. 어느 인덱스에서 회수됐는지로 정하면, 업체 자기 도메인의
    //    글이 blog 인덱스에서 나왔다는 이유만으로 `official_blog` 가 된다.
    let host = "";
    try {
      host = new URL(link).hostname;
    } catch {
      host = "";
    }
    if (/youtube\.com|youtu\.be/i.test(host)) return "official_video";
    if (BLOG_HOSTS.test(host)) return "official_blog";
    return "official_site";
  }
  switch (provider) {
    case "blog":
      return "thirdparty_blog";
    case "cafearticle":
      return "cafe";
    case "news":
      return "news";
    case "webkr":
      return "webdoc";
  }
}

function classify(hit: SearchHit, provider: OrsChannel, ctx: OrsContext, now: Date): ClassifiedHit {
  let host = "";
  try {
    host = new URL(hit.link).hostname;
  } catch {
    host = "";
  }

  const isOfficial =
    (host !== "" && hostMatches(host, ctx.officialDomains)) ||
    channelMatches(hit.link, ctx.officialChannelUrls) ||
    (hit.sourceUrl !== undefined && channelMatches(hit.sourceUrl, ctx.officialChannelUrls));

  // 상호가 제목·본문에 있으면 "관련" 이다. 공식은 아니어도 언급은 언급이다.
  const brand = normalizeCompanyName(ctx.companyName);
  const haystack = normalizeCompanyName(`${hit.title} ${hit.description} ${hit.sourceName ?? ""}`);
  const isRelated = isOfficial || (brand.length >= 3 && haystack.includes(brand));

  return {
    rank: hit.rank,
    url: hit.link,
    urlHash: hashUrl(hit.link),
    channelType: channelTypeFor(provider, isOfficial, hit.link),
    isOfficial,
    isRelated,
    recency: recencyOf(hit.publishedAt, now),
    title: hit.title,
    ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
  };
}

/** 채널 하나의 집계. */
export function aggregateChannel(result: SearchResult, ctx: OrsContext): ChannelAggregate {
  const now = ctx.now ?? new Date();
  const provider = result.provider as OrsChannel;

  // 같은 채널 응답 안의 중복 URL 도 한 건으로 본다.
  const seen = new Set<string>();
  const hits: ClassifiedHit[] = [];
  for (const raw of result.hits) {
    const classified = classify(raw, provider, ctx, now);
    if (seen.has(classified.urlHash)) continue;
    seen.add(classified.urlHash);
    hits.push(classified);
  }

  const denominator = Math.min(ORS_DENOMINATOR_CAP, result.total, hits.length);
  const scored = hits.slice(0, denominator);

  const recencyDist: Record<RecencyBucket, number> = { d0_60: 0, d61_120: 0, d120_plus: 0, unknown: 0 };
  for (const hit of scored) recencyDist[hit.recency]++;

  const officialCount = scored.filter((h) => h.isOfficial).length;
  const relatedCount = scored.filter((h) => h.isRelated).length;

  return {
    provider,
    totalReturned: result.total,
    denominator,
    relatedCount,
    officialCount,
    ors: denominator === 0 ? null : Math.round((officialCount / denominator) * 10_000) / 10_000,
    recencyDist,
    hits,
  };
}

/**
 * 여러 채널의 집계를 한 번에 만든다.
 *
 * 채널 **간** 중복 URL 은 먼저 본 채널에만 `search_hits` 행으로 남긴다
 * (`unique (attempt_id, company_id, keyword, url_hash)`). 다만 채널별 집계 수치는
 * 각자의 응답을 기준으로 계산한다 — 다른 채널에서 먼저 봤다는 이유로 이 채널의
 * 회수량을 깎으면 채널 간 비교가 무너진다.
 */
export function aggregateAll(
  results: readonly SearchResult[],
  ctx: OrsContext,
): { aggregates: ChannelAggregate[]; dedupedHits: ClassifiedHit[] } {
  const aggregates: ChannelAggregate[] = [];
  const globalSeen = new Set<string>();
  const dedupedHits: ClassifiedHit[] = [];

  for (const result of results) {
    const aggregate = aggregateChannel(result, ctx);
    aggregates.push(aggregate);
    for (const hit of aggregate.hits) {
      if (globalSeen.has(hit.urlHash)) continue;
      globalSeen.add(hit.urlHash);
      dedupedHits.push(hit);
    }
  }

  return { aggregates, dedupedHits };
}
