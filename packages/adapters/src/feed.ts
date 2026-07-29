import { XMLParser } from "fast-xml-parser";

/**
 * RSS 2.0 · Atom · RSS 1.0(RDF) 피드 파서.
 *
 * 공식 채널의 **발행 시각만** 필요하다. 본문은 파싱하지도, 반환하지도 않는다 —
 * 피드 본문에는 이메일이 들어 있을 수 있고, 우리는 그것을 수집하지 않는다
 * (정보통신망법 제50조의2 · 설계서 결론 A). 제목은 콘텐츠 성격 분류에만 쓰고
 * 저장하지 않는다.
 */

export interface FeedEntry {
  /** 콘텐츠 성격 분류에만 쓴다. 저장하지 않는다. */
  readonly title: string;
  /** 발행 시각. 파싱하지 못하면 없다. */
  readonly publishedAt?: Date | undefined;
}

export interface ParsedFeed {
  readonly title?: string | undefined;
  readonly entries: readonly FeedEntry[];
  /** 날짜를 읽지 못한 항목 수. 0 이 아니면 지표 신뢰도가 떨어진다. */
  readonly undatedCount: number;
}

/** 피드 하나에서 이만큼만 본다. 전체 아카이브를 주는 피드가 있다. */
const MAX_ENTRIES = 200;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // `dc:date` · `atom:published` 처럼 접두어가 붙은 태그를 접두어 없이 다룬다.
  removeNSPrefix: true,
  // 날짜·제목을 숫자로 바꿔 버리면 곤란하다. 전부 문자열로 받는다.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

const asArray = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

/** 태그 값이 문자열이거나 `{ "#text": ... }` 형태일 수 있다. */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  if (value !== null && typeof value === "object") {
    const inner = (value as Record<string, unknown>)["#text"];
    if (typeof inner === "string") return inner.trim() || undefined;
  }
  return undefined;
}

/**
 * 날짜 문자열을 파싱한다.
 *
 * RSS 의 `pubDate` 는 RFC 822(`Mon, 15 Jul 2026 10:00:00 +0900`),
 * Atom 의 `published` 는 ISO 8601 이다. 둘 다 `Date` 가 처리한다.
 * 미래 날짜는 신뢰하지 않는다 — 발행 예약이나 잘못된 서버 시계다.
 */
function parseDate(raw: string | undefined, now: Date): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (parsed.getTime() > now.getTime() + 24 * 3600 * 1000) return undefined;
  // 1990년 이전은 파싱 사고로 본다 (`0000-00-00` 류).
  if (parsed.getUTCFullYear() < 1990) return undefined;
  return parsed;
}

const DATE_KEYS = ["pubDate", "published", "date", "updated", "created", "issued"] as const;

function entryFrom(node: Record<string, unknown>, now: Date): FeedEntry {
  let published: Date | undefined;
  for (const key of DATE_KEYS) {
    published = parseDate(text(node[key]), now);
    if (published) break;
  }
  return {
    title: text(node["title"]) ?? "",
    ...(published ? { publishedAt: published } : {}),
  };
}

/**
 * 피드를 파싱한다. 형식을 알아보지 못하면 **던지지 않고** 빈 결과를 준다 —
 * 피드가 깨진 것은 관측 결과(`unavailable`)이지 파이프라인 오류가 아니다.
 */
export function parseFeed(xml: string, now: Date = new Date()): ParsedFeed {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { entries: [], undatedCount: 0 };
  }
  if (!doc || typeof doc !== "object") return { entries: [], undatedCount: 0 };

  // RSS 2.0: rss > channel > item
  // RSS 1.0: RDF > item (channel 밖에 있다)
  // Atom:    feed > entry
  const rss = doc["rss"] as Record<string, unknown> | undefined;
  const rdf = doc["RDF"] as Record<string, unknown> | undefined;
  const atom = doc["feed"] as Record<string, unknown> | undefined;

  let feedTitle: string | undefined;
  let rawItems: unknown[] = [];

  if (rss) {
    const channel = rss["channel"] as Record<string, unknown> | undefined;
    feedTitle = text(channel?.["title"]);
    rawItems = asArray(channel?.["item"]);
  } else if (rdf) {
    const channel = rdf["channel"] as Record<string, unknown> | undefined;
    feedTitle = text(channel?.["title"]);
    rawItems = asArray(rdf["item"]);
  } else if (atom) {
    feedTitle = text(atom["title"]);
    rawItems = asArray(atom["entry"]);
  } else {
    return { entries: [], undatedCount: 0 };
  }

  const entries: FeedEntry[] = [];
  let undated = 0;
  for (const raw of rawItems.slice(0, MAX_ENTRIES)) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = entryFrom(raw as Record<string, unknown>, now);
    if (!entry.publishedAt) undated++;
    entries.push(entry);
  }

  return {
    ...(feedTitle ? { title: feedTitle } : {}),
    entries,
    undatedCount: undated,
  };
}
