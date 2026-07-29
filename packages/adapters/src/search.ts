import { assertSourceApproved, configError, LeadOpsError } from "@leadops/core";
import type { HttpClient } from "@leadops/http";
import { AdapterNotConfiguredError } from "./types";

/**
 * 검색 어댑터 계약 (설계서 3절 ORS · 5.3 스테이지 8).
 *
 * ⚠️ **ORS 는 배점 0 의 shadow feature 다.** 네이버 Open API 를 영업 리드 발굴에 쓰는 것이
 *    약관상 허용되는지 확인되지 않았다(R2). `FEATURE_ORS` 3-state 와 `source_registry` 의
 *    서면 근거(`written_approval_ref`)가 둘 다 충족돼야 어댑터가 만들어진다.
 *
 * ⚠️ 이 어댑터는 **실 API 로 검증되지 않았다** (`verifiedAgainstLiveApi = false`).
 *    자격증명이 없어 응답 형태를 실측하지 못했다. 필드명은 네이버 개발자 문서를 근거로
 *    작성했고, 키가 생기면 `pnpm spike verify` 로 확인한 뒤 플래그를 바꾼다.
 */

/** ORS 산출에 쓰는 채널 4종. `local` 은 ORS 에서 제외한다(설계서 3절). */
export const ORS_CHANNELS = Object.freeze(["blog", "cafearticle", "webkr", "news"] as const);
export type OrsChannel = (typeof ORS_CHANNELS)[number];
export type SearchProvider = OrsChannel | "local";

export interface SearchHit {
  /** 1부터 시작하는 응답 내 순위. "검색 순위" 가 아니라 회수 순서다. */
  readonly rank: number;
  readonly title: string;
  readonly link: string;
  readonly description: string;
  readonly publishedAt?: Date | undefined;
  /** 블로그명·카페명 등 출처 표시. 공식 채널 판별의 보조 신호. */
  readonly sourceName?: string | undefined;
  readonly sourceUrl?: string | undefined;
}

export interface SearchResult {
  readonly provider: SearchProvider;
  readonly keyword: string;
  /** API 가 보고한 전체 매칭 수. ORS 분모 계산의 입력이다. */
  readonly total: number;
  readonly hits: readonly SearchHit[];
}

export interface SearchAdapter {
  readonly sourceName: string;
  readonly verifiedAgainstLiveApi: boolean;
  /** 이 호출이 소비하는 쿼터 단위. 네이버는 호출당 1. */
  readonly unitsPerCall: number;
  search(provider: SearchProvider, keyword: string, display?: number): Promise<SearchResult>;
}

/** 네이버 Open API 는 `<b>` 로 검색어를 강조해 돌려준다. 저장 전에 벗긴다. */
export function stripHighlight(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<\/?b>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** `20260715` (blog postdate) 또는 RFC822 (news pubDate). */
export function parseHitDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim());
  const parsed = compact
    ? new Date(Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3])))
    : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (parsed.getUTCFullYear() < 1990) return undefined;
  return parsed;
}

/** 채널별 `display` 상한 (설계서 3.1 — local 만 5). */
export const MAX_DISPLAY: Record<SearchProvider, number> = {
  blog: 100,
  cafearticle: 100,
  webkr: 100,
  news: 100,
  local: 5,
};

/**
 * 네이버 Search API 는 API HUB 로 이관 중이라고 알려져 있으나 확인하지 못했다(R2-04).
 * 구현을 갈라 두고, 검증되지 않은 쪽은 **조용히 동작하지 않고 거부한다.**
 */
export type NaverVariant = "legacy" | "apihub";

export interface NaverSearchOptions {
  clientId: string;
  clientSecret: string;
  http: HttpClient;
  variant?: NaverVariant;
}

const LEGACY_BASE = "https://openapi.naver.com/v1/search";

export class NaverSearchAdapter implements SearchAdapter {
  readonly sourceName = "naver_search";
  /** ⚠️ 실 API 응답으로 검증되지 않았다. 자격증명 확보 후 `pnpm spike verify` 로 확인한다. */
  readonly verifiedAgainstLiveApi = false;
  readonly unitsPerCall = 1;

  readonly #id: string;
  readonly #secret: string;
  readonly #http: HttpClient;

  constructor(options: NaverSearchOptions) {
    // ORS 계열은 서면 근거가 있어야 한다. 없으면 여기서 실패한다.
    assertSourceApproved(this.sourceName, true);

    const variant = options.variant ?? "legacy";
    if (variant !== "legacy") {
      throw configError(
        "API HUB 변형은 아직 검증되지 않았습니다. 엔드포인트·인증·쿼터를 확인한 뒤 구현하세요 (R2-04)",
        { variant },
      );
    }
    if (!options.clientId || !options.clientSecret) {
      throw new AdapterNotConfiguredError(this.sourceName, "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET");
    }
    this.#id = options.clientId;
    this.#secret = options.clientSecret;
    this.#http = options.http;
  }

  async search(provider: SearchProvider, keyword: string, display = 30): Promise<SearchResult> {
    const capped = Math.min(display, MAX_DISPLAY[provider]);
    const url = new URL(`${LEGACY_BASE}/${provider}.json`);
    url.searchParams.set("query", keyword);
    url.searchParams.set("display", String(capped));
    url.searchParams.set("start", "1");
    url.searchParams.set("sort", "sim");

    const res = await this.#http.get(url.href, {
      headers: {
        "X-Naver-Client-Id": this.#id,
        "X-Naver-Client-Secret": this.#secret,
      },
      acceptContentTypes: ["application/json", "text/json"],
    });

    return parseNaverResponse(provider, keyword, res.body);
  }
}

/**
 * 응답을 해석한다.
 *
 * 형태가 어긋나면 "0건" 이 아니라 **에러**다. fail-open 은 검색 공백을 조작하는 가장
 * 쉬운 경로이고, 그대로 두면 모든 업체가 "콘텐츠 없음" 으로 보인다.
 */
export function parseNaverResponse(
  provider: SearchProvider,
  keyword: string,
  body: string,
): SearchResult {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new LeadOpsError("parse_error", `네이버 ${provider} 응답이 JSON 이 아닙니다`, {
      details: { provider, bytes: body.length },
    });
  }
  if (doc === null || typeof doc !== "object") {
    throw new LeadOpsError("parse_error", `네이버 ${provider} 응답 형태가 올바르지 않습니다`, {
      details: { provider },
    });
  }

  const envelope = doc as Record<string, unknown>;
  if (typeof envelope["errorCode"] === "string") {
    throw new LeadOpsError("parse_error", `네이버 ${provider} 오류: ${String(envelope["errorMessage"])}`, {
      details: { provider, code: envelope["errorCode"] },
    });
  }

  const total = envelope["total"];
  const items = envelope["items"];
  if (typeof total !== "number" || !Array.isArray(items)) {
    throw new LeadOpsError("parse_error", `네이버 ${provider} 응답에 total·items 가 없습니다`, {
      details: { provider, keys: Object.keys(envelope).slice(0, 10) },
    });
  }

  const hits: SearchHit[] = [];
  for (const [index, raw] of items.entries()) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const link = typeof item["link"] === "string" ? item["link"] : "";
    if (link === "") continue;

    const published = parseHitDate(item["postdate"]) ?? parseHitDate(item["pubDate"]);
    const sourceName = stripHighlight(item["bloggername"] ?? item["cafename"] ?? item["publisher"]);
    const sourceUrl = typeof item["bloggerlink"] === "string"
      ? item["bloggerlink"]
      : typeof item["cafeurl"] === "string"
        ? item["cafeurl"]
        : undefined;

    hits.push({
      rank: index + 1,
      title: stripHighlight(item["title"]),
      link,
      description: stripHighlight(item["description"]),
      ...(published ? { publishedAt: published } : {}),
      ...(sourceName ? { sourceName } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
    });
  }

  return { provider, keyword, total, hits };
}
