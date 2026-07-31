import type { ApiLeadRow, ApiReviewDetail, ApiReviewRow } from "./client";
import type {
  CompetitorRow,
  ContactPageCandidate,
  EmailType,
  EnteredEmail,
  Industry,
  Lead,
  OrsChannel,
  OrsChannelResult,
  ReviewItem,
  Weakness,
  WeaknessSeverity,
} from "./types";

/**
 * API 응답 → 화면 타입.
 *
 * ❗ **없는 값을 0 으로 채우지 않는다.** 서버가 `null` 을 주는 이유는 측정하지 못했기
 *    때문이고, 그것을 0 으로 바꾸면 화면이 "아무것도 없다" 고 단정한다. 백엔드가 지키는
 *    원칙(설계서 A.6)이 UI 에서 무너지면 검수자가 잘못된 판단을 한다.
 *
 * ❗ 목록 응답에는 상세 전용 필드(ORS·경쟁사·채널)가 없다. 목록에서 만든 항목은
 *    `detailLoaded = false` 로 두고, 드로어를 열 때 상세로 덮어쓴다.
 */

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : v === null || v === undefined ? null : Number(v) || null;

const text = (v: unknown): string => (typeof v === "string" ? v : "");

const industryOf = (v: unknown): Industry => {
  const value = text(v);
  return value === "derm" || value === "plastic" || value === "dental" || value === "franchise"
    ? value
    : "derm";
};

const severityOf = (v: unknown): WeaknessSeverity => {
  const value = text(v);
  return value === "strong" || value === "medium" || value === "clear_gap" || value === "weak"
    ? value
    : "weak";
};

function weaknessesOf(raw: unknown): Weakness[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((w) => {
    const row = (w ?? {}) as Record<string, unknown>;
    const metric = text(row["metric"]);
    return {
      kind: text(row["kind"]),
      label: text(row["label"]) || text(row["kind"]),
      severity: severityOf(row["severity"]),
      ...(metric ? { metric } : {}),
    };
  });
}

/** URL 에서 표시용 경로만 남긴다. `https://a.kr/contact` → `/contact` */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? "/" : u.pathname.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

const PAGE_KIND_LABEL: Record<string, string> = {
  contact: "문의·오시는 길",
  about: "소개",
  privacy: "개인정보처리방침",
  terms: "이용약관",
  footer: "사업자정보",
  partnership: "제휴",
};

export function mapListItem(row: ApiReviewRow): ReviewItem {
  return {
    id: row.id,
    rank: row.rank,
    companyName: row.name,
    industry: industryOf(row.industry),
    regionSido: row.region_sido ?? "",
    regionSigungu: row.region_sigungu ?? "",
    homepageStatus: "unavailable",
    placeRegistered: false,
    score: {
      problem: row.axis_problem,
      propensity: row.axis_propensity,
      confidence: row.axis_confidence,
      total: row.total,
    },
    scoreRationale: [],
    weaknesses: weaknessesOf(row.weaknesses),
    ors: [],
    orsScored: false,
    competitors: [],
    competitorGapAvailable: false,
    activity60d: 0,
    activity120d: 0,
    searchAssets: [],
    contactPages: [],
    primaryService: row.primary_service ?? "미정",
    secondaryServices: row.secondary_services ?? [],
    recommendRationale: "",
    ...(row.email_address
      ? {
          email: {
            ...(row.email_id ? { id: row.email_id } : {}),
            address: row.email_address,
            type: "inquiry" as EmailType,
            sourcePath: "",
            verification: row.mx_ok === true ? ("mx_ok" as const) : ("failed" as const),
          },
        }
      : {}),
    status: row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "pending",
    detailLoaded: false,
  };
}

/** 채널 관측을 화면이 쓰는 활동량으로 접는다. 분석하지 못한 채널은 세지 않는다. */
function activityOf(channels: Array<Record<string, unknown>>): {
  activity60d: number;
  activity120d: number;
  lastContentAt?: string;
  placeRegistered: boolean;
} {
  let a60 = 0;
  let a120 = 0;
  let last: string | undefined;
  let place = false;

  for (const raw of channels) {
    if (text(raw["type"]) === "place") place = true;
    if (raw["analyzable"] !== true) continue;
    a60 += num(raw["posts_60d"]) ?? 0;
    a120 += num(raw["posts_120d"]) ?? 0;
    const posted = text(raw["last_post_at"]).slice(0, 10);
    if (posted && (last === undefined || posted > last)) last = posted;
  }
  return { activity60d: a60, activity120d: a120, ...(last === undefined ? {} : { lastContentAt: last }), placeRegistered: place };
}

const ORS_CHANNELS: readonly OrsChannel[] = ["blog", "cafe", "web", "news"];

/** 제공자 이름을 화면 채널 이름으로 옮긴다 (`cafearticle` → `cafe`, `webkr` → `web`). */
function channelOf(provider: string): OrsChannel | undefined {
  if (provider === "blog") return "blog";
  if (provider === "cafearticle") return "cafe";
  if (provider === "webkr") return "web";
  if (provider === "news") return "news";
  return undefined;
}

function orsOf(rows: Array<Record<string, unknown>>): OrsChannelResult[] {
  if (rows.length === 0) return [];
  const byChannel = new Map<OrsChannel, number>();
  for (const raw of rows) {
    const channel = channelOf(text(raw["provider"]));
    if (!channel) continue;
    if ((num(raw["denominator"]) ?? 0) === 0) continue; // 측정 불가 — 0 으로 세지 않는다
    byChannel.set(channel, (byChannel.get(channel) ?? 0) + (num(raw["official_count"]) ?? 0));
  }
  return ORS_CHANNELS.filter((c) => byChannel.has(c)).map((channel) => ({
    channel,
    count: byChannel.get(channel) ?? 0,
    // 경쟁사 ORS 는 비율이고 이 값은 건수다. 단위가 달라 비교할 수 없으므로 null 로 둔다.
    competitorMedian: null,
  }));
}

function competitorsOf(rows: Array<Record<string, unknown>>): CompetitorRow[] {
  return rows.map((raw) => ({
    name: text(raw["competitor_name"]),
    isValid: raw["is_valid"] === true,
    ors: num(raw["ors"]),
    officialAssets: null,
    recency60d: num(raw["recency_60d"]),
    channelActivity: num(raw["channel_activity"]),
  }));
}

function contactPagesOf(rows: ApiReviewDetail["contactPages"]): ContactPageCandidate[] {
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    path: pathOf(row.url),
    label: row.link_text || PAGE_KIND_LABEL[row.page_kind] || row.page_kind,
    confidence: row.confidence,
  }));
}

/** 점수 근거. `breakdown` 의 적용 항목을 사람이 읽을 줄로 바꾼다. */
function rationaleOf(breakdown: unknown): string[] {
  if (breakdown === null || typeof breakdown !== "object") return [];
  const out: string[] = [];
  for (const axis of ["problem", "propensity", "confidence"]) {
    const section = (breakdown as Record<string, unknown>)[axis];
    if (section === null || typeof section !== "object") continue;
    const items = (section as Record<string, unknown>)["items"];
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const points = num(item["points"]) ?? 0;
      if (item["unavailable"] === true) {
        out.push(`${text(item["label"])}: 측정 불가 (${text(item["note"])})`);
      } else if (points > 0) {
        out.push(`${text(item["label"])} +${points}${item["note"] ? ` (${text(item["note"])})` : ""}`);
      }
    }
  }
  return out;
}

function emailOf(raw: Record<string, unknown> | null): EnteredEmail | undefined {
  if (!raw) return undefined;
  const hosts = Array.isArray(raw["mx_hosts"]) ? (raw["mx_hosts"] as string[]) : [];
  return {
    id: text(raw["id"]),
    address: text(raw["address"]),
    type: (text(raw["email_type"]) || "unknown") as EmailType,
    sourcePath: "",
    verification:
      raw["mx_ok"] === true
        ? "mx_ok"
        : raw["dns_ok"] === true
          ? "dns_ok"
          : raw["syntax_ok"] === true
            ? "syntax_ok"
            : "failed",
    ...(hosts.length > 0 ? { mxHosts: hosts } : {}),
  };
}

export function mapDetail(payload: ApiReviewDetail): ReviewItem {
  const item = payload.item;
  const site = payload.websites[0];
  const activity = activityOf(payload.channels);
  const homepageUrl = site ? text(site["canonical_url"]) : "";
  const status = text(item["status"]);

  return {
    id: text(item["id"]),
    rank: num(item["rank"]) ?? 0,
    companyName: text(item["name"]),
    industry: industryOf(item["industry"]),
    regionSido: text(item["region_sido"]),
    regionSigungu: text(item["region_sigungu"]),
    ...(homepageUrl ? { homepageUrl } : {}),
    homepageStatus: (site ? text(site["official_status"]) : "unavailable") as ReviewItem["homepageStatus"],
    placeRegistered: activity.placeRegistered,
    score: {
      problem: num(item["axis_problem"]) ?? 0,
      propensity: num(item["axis_propensity"]) ?? 0,
      confidence: num(item["axis_confidence"]) ?? 0,
      total: num(item["total"]) ?? 0,
    },
    scoreRationale: rationaleOf(item["breakdown"]),
    weaknesses: weaknessesOf(item["weaknesses"]),
    ors: orsOf(payload.ors),
    orsScored: item["ors_scored"] === true,
    competitors: competitorsOf(payload.competitors),
    competitorGapAvailable: item["competitor_gap_available"] === true,
    activity60d: activity.activity60d,
    activity120d: activity.activity120d,
    ...(activity.lastContentAt === undefined ? {} : { lastContentAt: activity.lastContentAt }),
    searchAssets: payload.search_hits.map((h) => ({
      channel: h.channel_type,
      // 제목이 없으면 URL 을 보여 준다 — 링크가 무엇인지는 알려야 한다.
      title: h.title ?? h.url,
      date: h.published_at ? h.published_at.slice(0, 10) : "",
      official: h.is_official,
    })),
    contactPages: contactPagesOf(payload.contactPages),
    primaryService: text(item["primary_service"]) || "미정",
    secondaryServices: Array.isArray(item["secondary_services"]) ? (item["secondary_services"] as string[]) : [],
    recommendRationale: text(item["rationale"]),
    ...(emailOf(payload.email) === undefined ? {} : { email: emailOf(payload.email)! }),
    status: status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending",
    detailLoaded: true,
    ...(payload.nonce === null ? {} : { nonce: payload.nonce }),
  };
}

export function mapLead(row: ApiLeadRow): Lead {
  return {
    id: row.id,
    companyName: row.name,
    industry: industryOf(row.industry),
    region: [row.region_sido, row.region_sigungu].filter(Boolean).join(" "),
    email: row.email_address ?? "",
    score: row.score,
    approvedAt: row.approval_date.slice(0, 10),
    // Outreach 모듈이 없어 서버가 발송 상태를 주지 않는다. 전부 READY 로 표시한다.
    status: "READY",
    contactBasis: row.contact_legal_basis,
    retentionUntil: row.retention_until.slice(0, 10),
    exportStatus: row.export_status,
  };
}
