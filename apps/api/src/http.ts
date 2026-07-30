import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "@leadops/core";
import { JwtError } from "./jwt";

/**
 * 최소 HTTP 계층 (설계서 7.2 공통 규약).
 *
 * 프레임워크를 쓰지 않는다 — 이 저장소는 의존성을 의도적으로 최소화해 왔고, 필요한 것은
 * 라우팅·JSON 파싱·에러 봉투 세 개뿐이다.
 *
 * 공통 규약:
 *   성공 `{ data, meta? }` · 실패 `{ error: { code, message, details? } }`
 *   커서 페이징 기본 50 / 최대 200
 */

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;

/** 요청 본문 상한. 검수 API 는 작은 JSON 만 받는다. */
const MAX_BODY_BYTES = 64 * 1024;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError(400, "bad_request", message, details);
export const notFound = (message = "찾을 수 없습니다"): ApiError => new ApiError(404, "not_found", message);
export const forbidden = (message = "권한이 없습니다"): ApiError => new ApiError(403, "forbidden", message);

/**
 * DB 가 던진 업무 규칙 위반을 HTTP 로 옮긴다.
 *
 * ❗ 알 수 없는 오류를 4xx 로 내리지 않는다. 규칙 위반과 버그를 섞으면 운영에서
 *    "정상적인 거절" 로 오해해 버그가 묻힌다. 목록에 없는 것은 전부 500 이다.
 */
const DB_ERROR_MAP: ReadonlyArray<{ match: RegExp; status: number; code: string; message: string }> = [
  { match: /unauthenticated/, status: 401, code: "unauthenticated", message: "인증이 필요합니다" },
  { match: /invalid_nonce/, status: 403, code: "invalid_nonce", message: "검수 화면을 다시 열어 주세요" },
  { match: /rate_limited/, status: 429, code: "rate_limited", message: "입력이 너무 빠릅니다. 잠시 후 다시 시도하세요" },
  { match: /daily_cap_reached/, status: 409, code: "daily_cap_reached", message: "오늘 승인 상한에 도달했습니다" },
  { match: /industry_quota_exceeded/, status: 409, code: "industry_quota_exceeded", message: "업종 비율 상한을 넘습니다" },
  { match: /score_gate_not_passed/, status: 409, code: "score_gate_not_passed", message: "점수 게이트를 통과하지 못한 후보입니다" },
  { match: /score_invalidated/, status: 409, code: "score_invalidated", message: "점수가 무효화되었습니다. 재실행 후 다시 검수하세요" },
  { match: /email_required|email_not_verified|mx/, status: 422, code: "email_not_verified", message: "MX 검증을 통과한 이메일이 필요합니다" },
  { match: /page_company_mismatch/, status: 400, code: "page_company_mismatch", message: "그 연락처 페이지는 이 업체의 것이 아닙니다" },
  { match: /invalid_syntax/, status: 400, code: "invalid_syntax", message: "이메일 형식이 올바르지 않습니다" },
  { match: /already_decided|not_pending/, status: 409, code: "already_decided", message: "이미 처리된 항목입니다" },
  { match: /no_data_found|query returned no rows/i, status: 404, code: "not_found", message: "찾을 수 없습니다" },
  { match: /permission denied/i, status: 403, code: "forbidden", message: "권한이 없습니다" },
  { match: /(^|[^a-z])forbidden([^a-z]|$)/, status: 403, code: "forbidden", message: "권한이 없습니다 (admin 필요)" },
];

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof JwtError) return new ApiError(401, "unauthenticated", err.message);

  const message = err instanceof Error ? err.message : String(err);
  for (const entry of DB_ERROR_MAP) {
    if (entry.match.test(message)) {
      return new ApiError(entry.status, entry.code, entry.message, { db: message.slice(0, 200) });
    }
  }
  if (process.env["API_DEBUG_ERRORS"]) {
    console.error("UNMAPPED:", JSON.stringify(message), "len", message.length, "entries", DB_ERROR_MAP.length,
      "msgCP", [...message].map((c) => c.codePointAt(0)).join(" "),
      "reCP", [...(DB_ERROR_MAP[12]?.match.source ?? "")].map((c) => c.codePointAt(0)).join(" "));
  }
  return new ApiError(500, "internal_error", "처리 중 오류가 발생했습니다");
}

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  /**
   * 인증된 사용자 id.
   *
   * ❗ **요청 컨텍스트에 담아 넘긴다.** 모듈 변수나 클래스 필드에 두면 Node 가 요청을
   *    동시에 처리하는 사이 다른 요청이 값을 덮어써, 사용자 A 의 응답에 B 의 데이터가
   *    들어갈 수 있다. 서버 전체에서 가장 위험한 종류의 버그다.
   */
  readonly userId: string;
  readonly logger: Logger;
  body<T>(): Promise<T>;
}

export type Handler = (ctx: Ctx) => Promise<unknown>;

interface Route {
  method: string;
  /** `/api/review/:id/decision` 형태. */
  pattern: string;
  handler: Handler;
}

export class Router {
  readonly #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.#routes.push({ method, pattern, handler });
    return this;
  }

  get = (p: string, h: Handler): this => this.add("GET", p, h);
  post = (p: string, h: Handler): this => this.add("POST", p, h);

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    const parts = pathname.replace(/\/+$/, "").split("/");
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const patternParts = route.pattern.split("/");
      if (patternParts.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (const [i, expected] of patternParts.entries()) {
        const actual = parts[i]!;
        if (expected.startsWith(":")) {
          if (actual === "") {
            ok = false;
            break;
          }
          params[expected.slice(1)] = decodeURIComponent(actual);
        } else if (expected !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return undefined;
  }
}

/** 본문을 상한까지만 읽는다. 넘으면 스트림을 끊는다. */
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(badRequest("요청 본문이 너무 큽니다"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // 검수 데이터는 캐시하지 않는다.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

export function makeCtx(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  params: Record<string, string>,
  userId: string,
  logger: Logger,
): Ctx {
  let cached: unknown;
  let read = false;
  return {
    req,
    res,
    url,
    params,
    userId,
    logger,
    async body<T>(): Promise<T> {
      if (!read) {
        const raw = await readBody(req);
        if (raw.trim() === "") {
          cached = {};
        } else {
          try {
            cached = JSON.parse(raw);
          } catch {
            throw badRequest("본문이 JSON 이 아닙니다");
          }
        }
        read = true;
      }
      return cached as T;
    },
  };
}

/** 커서 페이징 파라미터. 상한을 넘기면 조용히 자르지 않고 거절한다. */
export function pageLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return PAGE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest("limit 은 1 이상의 정수여야 합니다");
  if (n > PAGE_MAX) throw badRequest(`limit 은 ${PAGE_MAX} 이하여야 합니다`, { max: PAGE_MAX });
  return n;
}
