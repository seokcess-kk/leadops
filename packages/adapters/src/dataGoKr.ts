import { LeadOpsError, redactUrl } from "@leadops/core";
import type { HttpClient } from "@leadops/http";

/**
 * 공공데이터포털(data.go.kr) 공통 클라이언트.
 *
 * 포털 API 는 표준 응답 봉투를 쓴다:
 *
 *   { response: { header: { resultCode, resultMsg },
 *                 body:   { items: { item: [...] } | "", numOfRows, pageNo, totalCount } } }
 *
 * 주의할 점 두 가지:
 *  - 결과가 0건이면 `items` 가 빈 문자열 `""` 로 온다.
 *  - 결과가 1건이면 `item` 이 배열이 아니라 객체로 오는 경우가 있다.
 * 둘 다 여기서 정규화한다.
 */

export interface DataGoKrEnvelope<T> {
  items: T[];
  pageNo: number;
  numOfRows: number;
  totalCount: number;
}

export interface DataGoKrRequest {
  /** `apis.data.go.kr` 이하의 전체 URL (쿼리 제외). */
  endpoint: string;
  params: Record<string, string | number | undefined>;
}

/**
 * serviceKey 를 쿼리스트링에 넣을 수 있는 형태로 만든다.
 *
 * data.go.kr 이 주는 두 키는 사실 같은 값이다:
 *   Decoding 키 = 원본 (base64 — `+` `/` `=` 를 포함할 수 있다)
 *   Encoding 키 = Decoding 키를 퍼센트 인코딩한 것 (`%2B` `%2F` `%3D`)
 *
 * ❗ Decoding 키를 인코딩 없이 URL 에 넣으면 키가 깨진다:
 *      `+` → 서버가 **공백**으로 해석
 *      `=` → 끝의 `==` 가 잘리거나 파라미터 구분자로 오해될 수 있다
 *    그 결과가 401 이다. (실제로 이 버그로 401 을 맞았다)
 *
 * 반대로 Encoding 키를 다시 인코딩하면 `%2B` → `%252B` 가 되어 역시 깨진다.
 * 그래서 **이미 인코딩된 형태인지 판별해서** 한 번만 인코딩한다.
 */
export function encodeServiceKey(key: string): string {
  // `%` + 16진수 2자리가 있으면 이미 Encoding 키다. 그대로 쓴다.
  if (/%[0-9A-Fa-f]{2}/.test(key)) return key;
  return encodeURIComponent(key);
}

export class DataGoKrClient {
  readonly #http: HttpClient;
  readonly #serviceKey: string;

  constructor(http: HttpClient, serviceKey: string) {
    this.#http = http;
    this.#serviceKey = serviceKey;
  }

  async get<T>(req: DataGoKrRequest): Promise<DataGoKrEnvelope<T>> {
    const url = new URL(req.endpoint);
    // serviceKey 는 URLSearchParams 로 넣으면 이미 인코딩된 Encoding 키가 이중
    // 인코딩되므로 직접 붙이되, encodeServiceKey 로 정확히 한 번만 인코딩한다.
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    qs.set("_type", "json");
    url.search = `serviceKey=${encodeServiceKey(this.#serviceKey)}&${qs.toString()}`;

    const res = await this.#http.get(url.href, {
      acceptContentTypes: ["application/json", "text/json", "text/plain", "application/xml", "text/xml"],
    });

    // ❗ 에러 메시지에 실릴 URL 은 serviceKey 를 지운 형태여야 한다.
    return parseDataGoKrJson<T>(res.body, redactUrl(url.href));
  }
}

export function parseDataGoKrJson<T>(body: string, contextUrl: string): DataGoKrEnvelope<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // 포털은 오류 시 XML 을 돌려주는 경우가 많다. 원문 앞부분을 남겨 진단을 돕는다.
    throw new LeadOpsError("parse_error", `공공데이터포털 응답을 JSON 으로 읽을 수 없습니다: ${contextUrl}`, {
      details: { head: body.slice(0, 300) },
    });
  }

  const response = (parsed as { response?: unknown }).response;
  if (!response || typeof response !== "object") {
    throw new LeadOpsError("parse_error", `예상과 다른 응답 구조입니다: ${contextUrl}`, {
      details: { head: body.slice(0, 300) },
    });
  }

  // ❗ 성공 응답의 형태를 엄격히 요구한다. header 나 resultCode 가 없는 응답을
  //    "빈 결과" 로 넘기면, 포털 장애가 "이 업종에는 업체가 0개" 로 둔갑한다.
  //    조용한 fail-open 은 수집 파이프라인에서 가장 나쁜 실패 방식이다.
  const header = (response as { header?: { resultCode?: string; resultMsg?: string } }).header;
  if (!header || typeof header.resultCode !== "string") {
    throw new LeadOpsError("parse_error", `응답에 header.resultCode 가 없습니다: ${contextUrl}`, {
      retryable: true,
      details: { head: body.slice(0, 300) },
    });
  }
  if (header.resultCode !== "00") {
    throw new LeadOpsError("http_error", `공공데이터포털 오류 ${header.resultCode}: ${header.resultMsg ?? ""}`, {
      // 트래픽 초과(22)·일시 오류는 재시도 가치가 있다. 키 오류(30·31)는 없다.
      retryable: ["04", "05", "20", "22"].includes(header.resultCode),
      details: { resultCode: header.resultCode, resultMsg: header.resultMsg },
    });
  }

  const bodyObj = (response as { body?: unknown }).body as
    | { items?: unknown; pageNo?: unknown; numOfRows?: unknown; totalCount?: unknown }
    | undefined;
  if (!bodyObj || typeof bodyObj !== "object") {
    throw new LeadOpsError("parse_error", `resultCode 는 00 인데 body 가 없습니다: ${contextUrl}`, {
      retryable: true,
      details: { head: body.slice(0, 300) },
    });
  }

  return {
    items: normalizeItems<T>(bodyObj.items),
    pageNo: toInt(bodyObj.pageNo, 1),
    numOfRows: toInt(bodyObj.numOfRows, 0),
    totalCount: toInt(bodyObj.totalCount, 0),
  };
}

function normalizeItems<T>(items: unknown): T[] {
  if (items === undefined || items === null || items === "") return [];
  if (Array.isArray(items)) return items as T[];
  if (typeof items === "object") {
    const inner = (items as { item?: unknown }).item;
    if (inner === undefined || inner === null || inner === "") return [];
    return Array.isArray(inner) ? (inner as T[]) : [inner as T];
  }
  return [];
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
