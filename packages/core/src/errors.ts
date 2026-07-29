/**
 * 에러 계층.
 *
 * 원칙: 실패는 조용히 넘어가지 않는다. 설정 누락·정책 위반은 부팅 시점에 즉시 죽고,
 * 네트워크 실패는 재시도 가능 여부(`retryable`)를 스스로 알고 있어야 한다.
 */

export type ErrorCode =
  | "config_error"
  | "source_not_approved"
  | "feature_disabled"
  | "policy_violation"
  | "ssrf_blocked"
  | "robots_blocked"
  | "http_error"
  | "timeout"
  | "rate_limited"
  | "quota_exceeded"
  | "parse_error"
  | "not_found";

export class LeadOpsError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LeadOpsError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = Object.freeze({ ...(options?.details ?? {}) });
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

/** 환경변수·설정이 잘못됐다. 부팅을 막아야 한다. */
export const configError = (message: string, details?: Record<string, unknown>): LeadOpsError =>
  new LeadOpsError("config_error", message, { retryable: false, ...(details ? { details } : {}) });

/** source_registry 에서 승인되지 않은 소스를 쓰려 했다. */
export const sourceNotApproved = (source: string, reason: string): LeadOpsError =>
  new LeadOpsError("source_not_approved", `데이터 소스 '${source}' 가 승인되지 않았습니다: ${reason}`, {
    retryable: false,
    details: { source, reason },
  });

/** 수집 정책(robots, 50조의2, SSRF 등) 위반. 절대 재시도하지 않는다. */
export const policyViolation = (message: string, details?: Record<string, unknown>): LeadOpsError =>
  new LeadOpsError("policy_violation", message, { retryable: false, ...(details ? { details } : {}) });

export const ssrfBlocked = (message: string, details?: Record<string, unknown>): LeadOpsError =>
  new LeadOpsError("ssrf_blocked", message, { retryable: false, ...(details ? { details } : {}) });

export const robotsBlocked = (url: string): LeadOpsError =>
  new LeadOpsError("robots_blocked", `robots.txt 가 접근을 허용하지 않습니다: ${url}`, {
    retryable: false,
    details: { url },
  });

export const quotaExceeded = (provider: string, used: number, cap: number): LeadOpsError =>
  new LeadOpsError("quota_exceeded", `${provider} 일일 호출 한도 도달 (${used}/${cap})`, {
    retryable: false,
    details: { provider, used, cap },
  });

export const isRetryable = (err: unknown): boolean =>
  err instanceof LeadOpsError ? err.retryable : false;
