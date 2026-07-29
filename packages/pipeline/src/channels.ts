import type { PageLink } from "./html";

/**
 * 공식 채널 발견 (설계서 5.3 스테이지 7 · 4.1).
 *
 * 채널을 **검색으로 찾지 않는다.** 이미 공식으로 판정된 홈페이지가 스스로 링크하고 있는
 * 주소만 채널로 인정한다. 검색으로 찾으면 동명이인·비공식 팬페이지를 공식으로 오인하고,
 * 네이버 쿼터도 쓴다. 홈페이지 링크는 이미 `homepage_detect` 가 받아 둔 것이므로 추가
 * 요청이 0회다.
 *
 * ❗ YouTube 는 Data API 대신 **공개 RSS 피드**를 쓴다
 *    (`youtube.com/feeds/videos.xml?channel_id=...`). 키도 쿼터도 필요 없고, 우리가 필요한
 *    신호("최근 발행이 없다")를 그대로 준다. 설계서 4.1 은 `channels.list`(1 unit)를 적었지만
 *    활성도 산출에는 불필요하다. 구독자 수 같은 규모 신호가 필요해지면 그때 추가한다.
 */

/** `channels.type` 열거형 중 이 모듈이 만들어 내는 값. */
export type DiscoveredChannelType = "official_blog" | "official_video" | "official_sns" | "place";

export type ChannelPlatform =
  | "naver_blog"
  | "tistory"
  | "brunch"
  | "youtube"
  | "instagram"
  | "facebook"
  | "x"
  | "threads"
  | "kakao"
  | "band"
  | "naver_place";

export interface DiscoveredChannel {
  readonly type: DiscoveredChannelType;
  /** 정규화된 채널 URL. `unique (company_id, type, url)` 의 키가 된다. */
  readonly url: string;
  readonly platform: ChannelPlatform;
  /** 플랫폼 내 식별자 (블로그 ID · 유튜브 채널 ID). */
  readonly handle?: string | undefined;
  /** 발행 이력을 가져올 수 있는가. */
  readonly analyzable: boolean;
  /** 가져올 수 없다면 그 이유. `channel_observations.unavailable_reason` 에 들어간다. */
  readonly unavailableReason?: string | undefined;
  /** 발행 이력 피드 주소. `analyzable` 이 true 일 때만 있다. */
  readonly feedUrl?: string | undefined;
}

/** 업체 하나에서 채널을 이만큼 넘게 잡지 않는다. 링크 팜 방어. */
const MAX_CHANNELS = 12;

/**
 * 저장된 채널 URL 을 다시 해석한다.
 *
 * `channels` 테이블은 type·url 만 갖는다. 피드 주소나 분석 가능 여부는 파생값이라
 * 저장하지 않고 필요할 때 다시 계산한다 — 규칙이 바뀌면 재실행만으로 반영된다.
 */
export function describeChannel(url: string): DiscoveredChannel | undefined {
  try {
    return classify(new URL(url));
  } catch {
    return undefined;
  }
}

const stripWww = (h: string): string => h.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");

/** 경로의 첫 세그먼트. `/abc/def` → `abc` */
function firstSegment(pathname: string): string | undefined {
  const seg = pathname.split("/").filter(Boolean)[0];
  return seg === undefined ? undefined : decodeURIComponent(seg);
}

/** 네이버 블로그 ID 는 영숫자·밑줄·하이픈이다. 게시글 경로를 ID 로 착각하지 않게 검사한다. */
const NAVER_BLOG_ID = /^[A-Za-z0-9_-]{3,40}$/;
const TISTORY_SUB = /^([A-Za-z0-9-]{2,40})\.tistory\.com$/;
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function classify(u: URL): DiscoveredChannel | undefined {
  const host = stripWww(u.hostname);

  // ── 네이버 블로그 ──
  if (host === "blog.naver.com" || host === "blog.me" || host === "post.naver.com") {
    // `blog.naver.com/{id}` · `blog.naver.com/PostList.naver?blogId={id}`
    const fromQuery = u.searchParams.get("blogId");
    const seg = firstSegment(u.pathname);
    const id = fromQuery ?? (seg && !seg.includes(".") ? seg : undefined);
    if (!id || !NAVER_BLOG_ID.test(id)) return undefined;
    return {
      type: "official_blog",
      url: `https://blog.naver.com/${id}`,
      platform: "naver_blog",
      handle: id,
      analyzable: true,
      feedUrl: `https://rss.blog.naver.com/${id}.xml`,
    };
  }

  // ── 티스토리 ──
  const tistory = TISTORY_SUB.exec(host);
  if (tistory) {
    const sub = tistory[1]!;
    return {
      type: "official_blog",
      url: `https://${sub}.tistory.com`,
      platform: "tistory",
      handle: sub,
      analyzable: true,
      feedUrl: `https://${sub}.tistory.com/rss`,
    };
  }

  // ── 브런치 ──
  if (host === "brunch.co.kr") {
    const seg = firstSegment(u.pathname);
    if (!seg?.startsWith("@")) return undefined;
    const id = seg.replace(/^@+/, "");
    if (!id) return undefined;
    return {
      type: "official_blog",
      url: `https://brunch.co.kr/@${id}`,
      platform: "brunch",
      handle: id,
      // 브런치 RSS 경로를 검증하지 못했다. 추측한 주소로 요청을 보내지 않는다.
      analyzable: false,
      unavailableReason: "brunch_feed_unverified",
    };
  }

  // ── 유튜브 ──
  if (host === "youtube.com" || host === "youtu.be") {
    const segments = u.pathname.split("/").filter(Boolean);
    const first = segments[0];
    if (first === "channel" && segments[1] && YOUTUBE_CHANNEL_ID.test(segments[1])) {
      const id = segments[1];
      return {
        type: "official_video",
        url: `https://www.youtube.com/channel/${id}`,
        platform: "youtube",
        handle: id,
        analyzable: true,
        feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
      };
    }
    if (first?.startsWith("@") && first.length > 1) {
      return {
        type: "official_video",
        url: `https://www.youtube.com/${first}`,
        platform: "youtube",
        handle: first.slice(1),
        // RSS 피드는 channel_id 만 받는다. 핸들 → ID 변환에는
        // channels.list(forHandle, 1 unit) 가 필요하다. 키가 생기면 해소된다.
        analyzable: false,
        unavailableReason: "youtube_handle_needs_resolution",
      };
    }
    if ((first === "c" || first === "user") && segments[1]) {
      return {
        type: "official_video",
        url: `https://www.youtube.com/${first}/${segments[1]}`,
        platform: "youtube",
        analyzable: false,
        unavailableReason: "youtube_legacy_url_needs_resolution",
      };
    }
    return undefined;
  }

  // ── SNS: 존재는 신호지만 발행 이력을 공개 API 로 얻을 수 없다 ──
  const sns: Array<[string, ChannelPlatform]> = [
    ["instagram.com", "instagram"],
    ["facebook.com", "facebook"],
    ["fb.com", "facebook"],
    ["twitter.com", "x"],
    ["x.com", "x"],
    ["threads.net", "threads"],
    ["pf.kakao.com", "kakao"],
    ["band.us", "band"],
  ];
  for (const [domain, platform] of sns) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      if (u.pathname === "/" || u.pathname === "") return undefined; // 플랫폼 홈 링크는 채널이 아니다
      return {
        type: "official_sns",
        url: `https://${host}${u.pathname.replace(/\/+$/, "")}`,
        platform,
        analyzable: false,
        unavailableReason: `${platform}_no_public_feed`,
      };
    }
  }

  // ── 네이버 플레이스 ──
  if (host === "place.naver.com" || host === "map.naver.com" || host === "naver.me") {
    return {
      type: "place",
      url: u.toString(),
      platform: "naver_place",
      analyzable: false,
      unavailableReason: "place_registration_signal_only",
    };
  }

  return undefined;
}

/**
 * 공식 홈페이지의 링크에서 공식 채널을 뽑는다.
 *
 * @param links `scanHtml` 이 뽑은 링크
 * @param baseUrl 상대 경로 해석 기준
 */
export function discoverChannels(links: readonly PageLink[], baseUrl: string): DiscoveredChannel[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const byKey = new Map<string, DiscoveredChannel>();
  for (const link of links) {
    const href = link.href.trim();
    if (href.length === 0 || href.startsWith("#")) continue;

    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;

    const channel = classify(abs);
    if (!channel) continue;

    const key = `${channel.type}|${channel.url}`;
    // 분석 가능한 쪽을 남긴다. 같은 채널이 여러 형태로 링크될 수 있다.
    const existing = byKey.get(key);
    if (!existing || (!existing.analyzable && channel.analyzable)) byKey.set(key, channel);
    if (byKey.size >= MAX_CHANNELS) break;
  }

  return [...byKey.values()];
}
