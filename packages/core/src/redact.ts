/**
 * PII 마스킹.
 *
 * 설계서 R7(개인정보 국외이전) 대응: 이메일 주소·담당자명은 해외 LLM 프롬프트,
 * 외부 로그, 에러 트래킹으로 **절대 나가면 안 된다**.
 *
 * 이 모듈은 "나가기 직전" 경계에서 강제로 호출된다.
 * - LLM 어댑터의 프롬프트 직렬화
 * - 로거의 구조화 필드 직렬화
 * - 에러 리포터
 *
 * 마스킹을 잊는 것을 막기 위해, 로거와 LLM 어댑터는 raw 객체를 받지 않고
 * `redactPII()` 를 통과한 값만 받도록 타입으로 제한한다(`Redacted<T>`).
 */

/** redactPII() 를 통과했음을 타입으로 증명하는 브랜드. */
declare const REDACTED: unique symbol;
export type Redacted<T> = T & { readonly [REDACTED]: true };

/** 이메일 주소 패턴. 로컬파트에 점·플러스·하이픈 허용. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 한국 전화번호 (02-1234-5678 / 010-1234-5678 / 0212345678 등). */
const PHONE_RE = /\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g;

/** 국제 표기 (+82-10-1234-5678, +82 2 1234 5678). 국내 표기와 별도로 잡는다. */
const INTL_PHONE_RE = /\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g;

/** 주민등록번호 형태. 수집하지 않지만 실수로 들어오면 반드시 지운다. */
const RRN_RE = /\b\d{6}[-\s]?[1-4]\d{6}\b/g;

/** PII 로 취급하는 키 이름. 값 전체를 지운다. */
const PII_KEYS = new Set([
  "email",
  "emails",
  "address", // emails.address
  "email_address",
  "emailAddress",
  "localPart",
  "local_part",
  "contactName",
  "contact_name",
  "representative",
  "representativeName",
  "phone",
  "phoneNumber",
  "mobile",
  "enteredBy",
]);

const MASK = "[redacted]";

export function redactString(input: string): string {
  return input
    .replace(EMAIL_RE, MASK)
    .replace(RRN_RE, MASK)
    .replace(INTL_PHONE_RE, MASK)
    .replace(PHONE_RE, MASK);
}

/**
 * 객체를 재귀적으로 마스킹한다.
 *
 * - PII_KEYS 에 해당하는 키는 값 전체를 `[redacted]` 로 치환
 * - 모든 문자열은 이메일·전화·주민번호 패턴을 치환
 * - 순환 참조는 `[circular]` 로 끊는다
 */
export function redactPII<T>(value: T): Redacted<T> {
  return redactInternal(value, new WeakSet()) as Redacted<T>;
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === "string") return redactString(value as string);
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function" || t === "symbol") return "[unserializable]";

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (typeof value === "object") {
    const obj = value as object;
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);

    if (Array.isArray(value)) {
      return value.map((v) => redactInternal(v, seen));
    }

    // Buffer·TypedArray 는 Object.entries 로 풀면 인덱스→바이트 객체가 되어
    // 로그를 폭발시킨다. 내용은 보지 않고 크기만 남긴다.
    if (ArrayBuffer.isView(value)) {
      return `[binary ${(value as ArrayBufferView).byteLength}B]`;
    }

    // Map/Set 은 Object.entries 로 {} 가 되어 내용이 조용히 사라진다.
    // 조용한 소실도 조용한 유출만큼 나쁘므로 명시적으로 처리한다.
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value) {
        const key = typeof k === "string" ? k : String(k);
        out[key] = PII_KEYS.has(key) ? MASK : redactInternal(v, seen);
      }
      return out;
    }
    if (value instanceof Set) {
      return [...value].map((v) => redactInternal(v, seen));
    }

    const out: Record<string, unknown> = {};
    // getter 가 던지면 마스킹 전체가 실패한다. 로깅 때문에 요청이 죽으면 안 되므로 흡수한다.
    for (const k of Object.keys(obj)) {
      if (PII_KEYS.has(k)) {
        out[k] = MASK;
        continue;
      }
      let raw: unknown;
      try {
        raw = (obj as Record<string, unknown>)[k];
      } catch {
        out[k] = "[getter-threw]";
        continue;
      }
      out[k] = redactInternal(raw, seen);
    }
    return out;
  }

  return "[unserializable]";
}

/**
 * URL 의 민감한 쿼리 파라미터를 마스킹한다.
 *
 * 공공데이터포털은 `serviceKey` 를 쿼리스트링으로 받는다. 그 URL 이 그대로
 * 로그·에러 메시지·재시도 경고에 실리면 **API 키가 로그에 남는다.**
 * 예외와 로그에 URL 을 넣기 전에 반드시 이 함수를 통과시킨다.
 */
const SENSITIVE_QUERY_KEYS = new Set([
  "servicekey",
  "apikey",
  "api_key",
  "key",
  "token",
  "access_token",
  "client_secret",
  "secret",
  "password",
  "signature",
]);

export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return redactString(input);
  }

  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(name.toLowerCase())) {
      url.searchParams.set(name, MASK);
    }
  }
  url.username = "";
  url.password = "";
  return url.href;
}

/**
 * 마스킹 누락 탐지용 assert.
 *
 * 테스트와 LLM 어댑터 내부에서 사용한다. 마스킹 후에도 이메일 패턴이 남아 있으면
 * 조용히 넘어가지 않고 던진다.
 */
export function assertNoPII(serialized: string, context: string): void {
  // 정규식마다 새 인스턴스를 만들어 전역 정규식의 lastIndex 상태를 공유하지 않는다.
  const checks: Array<[string, RegExp]> = [
    ["email", new RegExp(EMAIL_RE.source, "g")],
    ["rrn", new RegExp(RRN_RE.source, "g")],
    ["phone", new RegExp(PHONE_RE.source, "g")],
    ["intl_phone", new RegExp(INTL_PHONE_RE.source, "g")],
  ];
  for (const [kind, re] of checks) {
    const found = serialized.match(re);
    if (found) {
      throw new Error(
        `PII 유출 차단: ${context} 에 마스킹되지 않은 ${kind} 이(가) 있습니다 (${found.length}건)`,
      );
    }
  }
}

/**
 * ⚠️ 이 모듈이 잡지 못하는 것 — 알고 쓸 것.
 *
 * 사람 이름(예: "김민수")은 정규식으로 식별할 수 없다. 따라서 `redactPII` 는
 * **키 이름 휴리스틱**(`PII_KEYS`)으로만 이름을 지운다. 키 이름이 다르면 통과한다.
 *
 * 진짜 통제는 "나가는 것을 지우는" 것이 아니라 **"나갈 것만 고르는"** 것이다.
 * LLM 경계(Phase 5)에서는 허용 필드만 담은 DTO 를 만들어 보내고, 이 모듈은
 * 그 위의 2차 방어선으로만 쓴다. 로그는 이 모듈을 1차 방어선으로 쓴다.
 */
export const REDACTION_LIMITS = Object.freeze({
  cannotDetect: ["사람 이름", "주소", "키 이름이 다른 임의 식별자"],
  primaryControl: "LLM 경계의 허용 필드 DTO (Phase 5)",
});
