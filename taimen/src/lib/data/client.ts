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

// ── 운영 엔드포인트 (설계서 7.2) ──

/**
 * `runs` 한 행.
 *
 * ❗ `counts` 는 스키마에만 있고 **아무도 쓰지 않는다** (마이그레이션 0002 에 선언, 파이프라인
 *    어디에서도 update 하지 않음). 항상 `{}` 이므로 퍼널 카운터의 출처로 쓸 수 없다 —
 *    화면은 이 값을 근거로 숫자를 만들지 않는다.
 * ❗ 네이버 쿼터는 실행 단위로 기록되지 않는다. `cost_ledger` 는 일 단위 원장이므로
 *    "이 실행이 쿼터를 얼마 썼는지" 는 API 가 알려 줄 수 없다.
 */
export interface ApiRunRow {
  id: string;
  run_date: string;
  trigger: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  counts: Record<string, unknown>;
  attempts: number | null;
  cost_krw: number;
}

export interface ApiRunStage {
  attempt_no: number;
  stage: string;
  status: string;
  total: number;
  done: number;
  failed: number;
  started_at: string | null;
  finished_at: string | null;
}

/** 실패한 잡. ❗ 업체명은 없다 — `jobs` 는 업체가 아니라 스테이지 단위다. */
export interface ApiFailedJob {
  id: string;
  stage: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

export interface ApiCostRow {
  provider: string;
  unit: string;
  qty: number;
  krw: number;
}

export interface ApiRunDetail {
  run: ApiRunRow & { settings_snapshot: Record<string, unknown> };
  stages: ApiRunStage[];
  failedJobs: ApiFailedJob[];
  costs: ApiCostRow[];
}

export interface ApiSettingRow {
  key: string;
  value: unknown;
  updated_at: string;
  updated_by: string | null;
}

export interface ApiSettings {
  rows: ApiSettingRow[];
  /** 파서를 통과한 **실제 적용값**. 저장된 JSON 과 다를 수 있다 (형식 오류는 기본값으로 되돌아간다). */
  effective: Record<string, Record<string, unknown>>;
}

export interface ApiIndustryRow {
  industry: string;
  companies: number;
  active: number;
  /** 공식(confirmed·likely) 으로 판정된 홈페이지를 가진 업체 수. URL 존재 수가 아니다. */
  with_homepage: number;
  keywords: number;
  approved: number;
  llm_pending: number;
  leads: number;
  quota: number;
}

/**
 * `company_keywords` 한 행.
 *
 * ❗ 업체별 **구체 키워드**다. fixture 가 보여 주던 `{업체명} {지역}` 형태의 *템플릿* 은
 *    DB 에 없는 개념이다 — 없는 것을 화면에 만들지 않는다.
 */
export interface ApiKeywordRow {
  id: string;
  keyword: string;
  kind: string;
  source: string;
  approved: boolean;
  priority: number;
  company_id: string;
  company_name: string;
  industry: string;
}

/**
 * `export_leads()` 가 내보내는 한 행.
 *
 * ❗ `_watermark` 는 **행마다 붙어 나온다** — 누가 언제 어느 범위를 내보냈는지가 데이터와
 *    함께 움직여야 유출 시 출처를 되짚을 수 있다. CSV 에서 이 열을 빼면 워터마크가 사라진다.
 * ❗ 횟수 제한·접촉 근거 게이트·감사 기록은 전부 RPC 안에 있다. 상한에 걸린 리드는
 *    **조용히 빠지므로** 화면은 "요청 건수" 가 아니라 실제 내보내진 건수를 보여 준다.
 */
export interface ApiExportRow {
  id: string;
  score: number;
  contact_legal_basis: string;
  company_name: string;
  industry: string;
  region_sido: string | null;
  region_sigungu: string | null;
  email: string;
  _watermark: { exported_by: string; exported_at: string; range: [string, string] };
}

/** `privacy_requests` 한 행. */
export interface ApiPrivacyRequest {
  id: string;
  kind: "access" | "delete" | "suspend" | "correct";
  subject_identifier: string;
  status: "received" | "in_progress" | "on_hold" | "completed" | "rejected";
  legal_hold: boolean;
  hold_reason: string | null;
  received_at: string;
  /** 접수 + 10일. 개인정보보호법 시행령 제41·43·44조. RPC 가 접수 시점에 못 박는다. */
  due_at: string;
  completed_at: string | null;
  actions_taken: Array<Record<string, unknown>>;
  company_id: string | null;
  company_name: string | null;
  overdue: boolean;
}

/**
 * 열람 보고서.
 *
 * ❗ 마스킹하지 않는다. 열람권은 본인 확인을 거친 정보주체가 자기 정보를 보는 권리다.
 */
export interface ApiAccessReport {
  subject_identifier: string;
  company: { id: string; name: string; industry: string; do_not_contact: boolean; opt_out_at: string | null } | null;
  emails: Array<{
    address: string;
    email_type: string;
    acquisition_method: string;
    collection_legal_basis: string;
    entered_at: string | null;
    retention_until: string;
    source_url: string | null;
  }>;
  leads: Array<{
    id: string;
    approval_date: string;
    contact_legal_basis: string;
    export_status: string;
    export_count: number;
    retention_until: string;
  }>;
  note: string;
}

export interface ApiCapacityReport {
  capacity: { bytes: number; limit_bytes: number; pct: number; level: "ok" | "warn" | "cleanup" | "block" };
  tables: Array<{ table: string; total_bytes: number; table_bytes: number; index_bytes: number; live_rows: number }>;
}

export interface ApiCosts {
  daily: Array<{ day: string; krw: number }>;
  providers: Array<ApiCostRow & { entries: number }>;
  caps: { daily_cap_krw: number | null; llm_monthly_cap_krw: number | null };
  todayKrw: number;
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

  /** export (admin 전용). 날짜는 `leads.created_at` 기준이다. */
  leadsExport: (from: string, to: string) =>
    request<ApiExportRow[]>("GET", `api/leads/export?from=${from}&to=${to}`),

  // ── 실행 이력 ──

  runs: (limit = 50) => request<ApiRunRow[]>("GET", `api/runs?limit=${limit}`),

  runDetail: (id: string) => request<ApiRunDetail>("GET", `api/runs/${encodeURIComponent(id)}`),

  /** 스테이지부터 재실행. 새 attempt 를 만들고 이전 점수를 무효화한다 (admin 전용). */
  retryRun: (id: string, fromStage: string) =>
    request<unknown>("POST", `api/runs/${encodeURIComponent(id)}/retry`, { fromStage }),

  /** 실행 취소 (admin 전용). 끝난 실행은 RPC 가 거절한다. */
  cancelRun: (id: string, reason?: string) =>
    request<unknown>("POST", `api/runs/${encodeURIComponent(id)}/cancel`, reason === undefined ? {} : { reason }),

  // ── 설정 · 비용 ──

  settings: () => request<ApiSettings>("GET", "api/settings"),

  /** 설정 한 키를 통째로 덮어쓴다 (admin 전용). 부분 갱신이 아니다. */
  updateSetting: (key: string, value: Record<string, unknown>) =>
    request<{ row: ApiSettingRow; effective: ApiSettings["effective"] }>(
      "PUT",
      `api/settings/${encodeURIComponent(key)}`,
      { value },
    ),

  /** ❗ admin 전용이다. 검수자에게는 403 이 온다 — 0 원으로 표시하면 안 된다. */
  costs: () => request<ApiCosts>("GET", "api/costs"),

  // ── 업종 · 키워드 ──

  industries: () => request<ApiIndustryRow[]>("GET", "api/industries"),

  keywords: (industry?: string, pendingOnly = false, limit = 200) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (industry) params.set("industry", industry);
    if (pendingOnly) params.set("pending", "1");
    return request<ApiKeywordRow[]>("GET", `api/keywords?${params.toString()}`);
  },

  approveKeyword: (id: string, approved: boolean) =>
    request<unknown>("POST", `api/keywords/${encodeURIComponent(id)}/approve`, { approved }),

  // ── 개인정보 · 용량 ──

  privacyRequests: (openOnly = false, limit = 200) =>
    request<ApiPrivacyRequest[]>("GET", `api/privacy/requests?limit=${limit}${openOnly ? "&open=1" : ""}`),

  createPrivacyRequest: (kind: string, subject: string, note?: string) =>
    request<{ ok: boolean; request_id: string; company_id: string | null }>(
      "POST",
      "api/privacy/requests",
      { kind, subject, ...(note === undefined ? {} : { note }) },
    ),

  advancePrivacyRequest: (id: string, status: string, note?: string) =>
    request<unknown>("POST", `api/privacy/requests/${encodeURIComponent(id)}/advance`, {
      status,
      ...(note === undefined ? {} : { note }),
    }),

  /** ❗ POST 다. 감사 기록을 남기는 동작이라 GET 이면 프리페치·캐시가 열람 기록을 만든다. */
  privacyAccessReport: (id: string) =>
    request<ApiAccessReport>("POST", `api/privacy/requests/${encodeURIComponent(id)}/access-report`),

  /** ❗ 되돌릴 수 없다. 이메일을 파기하고 접촉을 영구 차단한다. */
  executePrivacyRequest: (id: string) =>
    request<Record<string, unknown>>("POST", `api/privacy/requests/${encodeURIComponent(id)}/execute`),

  capacity: () => request<ApiCapacityReport>("GET", "api/capacity"),
};
