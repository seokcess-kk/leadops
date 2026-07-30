/**
 * 검수 API 클라이언트 (브라우저).
 *
 * 항상 `/api/gateway/*` 로 보낸다 — 토큰은 서버 프록시가 붙인다. 브라우저는 토큰을
 * 가지고 있지 않다 (`src/lib/server/token.ts` 참고).
 */

/** 서버가 돌려준 오류. 상태 코드와 코드를 그대로 들고 있어야 UI 가 구분할 수 있다. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 사용자가 고칠 수 있는 문제인가 (규칙 위반) — 아니면 우리 쪽 오류다. */
  get isRuleViolation(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

interface Envelope<T> {
  data?: T;
  meta?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<{ data: T; meta?: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`/api/gateway/${path.replace(/^\/+/, "")}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network_error", "서버에 연결할 수 없습니다.");
  }

  let payload: Envelope<T>;
  try {
    payload = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError(res.status, "bad_response", `서버 응답을 해석할 수 없습니다 (${res.status}).`);
  }

  if (!res.ok || payload.error) {
    const error = payload.error;
    throw new ApiError(res.status, error?.code ?? "unknown", error?.message ?? `요청이 실패했습니다 (${res.status}).`, error?.details);
  }
  if (payload.data === undefined) throw new ApiError(res.status, "bad_response", "응답에 데이터가 없습니다.");
  return { data: payload.data, ...(payload.meta === undefined ? {} : { meta: payload.meta }) };
}

// ── 응답 형태 (API 가 주는 그대로. 카멜케이스 변환은 mapper 가 한다) ──

export interface ApiWeakness {
  kind: string;
  severity: string;
  label: string;
  metric?: string;
}

export interface ApiReviewRow {
  id: string;
  rank: number;
  status: string;
  company_id: string;
  name: string;
  industry: string;
  region_sido: string | null;
  region_sigungu: string | null;
  axis_problem: number;
  axis_propensity: number;
  axis_confidence: number;
  total: number;
  normalized: number | null;
  weaknesses: ApiWeakness[] | null;
  primary_service: string | null;
  secondary_services: string[] | null;
  email_id: string | null;
  email_address: string | null;
  mx_ok: boolean | null;
}

export interface ApiReviewDetail {
  item: Record<string, unknown>;
  websites: Array<Record<string, unknown>>;
  contactPages: Array<{
    id: string;
    url: string;
    page_kind: string;
    link_text: string | null;
    confidence: number | null;
  }>;
  channels: Array<Record<string, unknown>>;
  ors: Array<Record<string, unknown>>;
  competitors: Array<Record<string, unknown>>;
  email: Record<string, unknown> | null;
  nonce: string | null;
}

export interface ApiContactEmailResult {
  emailId: string;
  syntaxOk: boolean;
  dnsOk: boolean;
  mxOk: boolean;
  mxHosts: string[];
  implicitMx: boolean;
  reason?: string;
}

export interface ApiLeadRow {
  id: string;
  approval_date: string;
  approved_industry: string;
  score: number;
  export_status: string;
  export_count: number;
  contact_legal_basis: string;
  retention_until: string;
  name: string;
  industry: string;
  region_sido: string | null;
  region_sigungu: string | null;
  email_address: string | null;
  mx_ok: boolean | null;
  email_type: string | null;
}

export const api = {
  reviewList: (status = "pending", limit = 200) =>
    request<ApiReviewRow[]>("GET", `api/review?status=${status}&limit=${limit}`),

  reviewDetail: (id: string) => request<ApiReviewDetail>("GET", `api/review/${encodeURIComponent(id)}`),

  submitContactEmail: (
    id: string,
    input: { address: string; emailType: string; contactPageId: string; nonce: string },
  ) => request<ApiContactEmailResult>("POST", `api/review/${encodeURIComponent(id)}/contact-email`, input),

  decide: (id: string, input: { status: "approved" | "rejected"; reason?: string; emailId?: string }) =>
    request<unknown>("POST", `api/review/${encodeURIComponent(id)}/decision`, input),

  bulkReject: (itemIds: string[], reason: string) =>
    request<Array<{ itemId: string; ok: boolean; error?: string }>>("POST", "api/review/bulk-decision", {
      itemIds,
      reason,
    }),

  leads: (limit = 200) => request<ApiLeadRow[]>("GET", `api/leads?limit=${limit}`),
};
