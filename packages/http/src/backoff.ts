/**
 * 재시도 백오프.
 *
 * 설계서 3.5절 / 7.1절: `min(2^attempts × base, cap) + jitter`.
 * jitter 는 여러 워커가 같은 순간에 몰려 재시도하는 것을 막는다.
 */

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** 0~1. 계산된 지연에 곱해질 무작위 가산분의 비율. */
  jitterRatio?: number;
  /** 테스트에서 고정하기 위한 난수원. */
  random?: () => number;
}

export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 2_000;
  const cap = options.capMs ?? 5 * 60_000;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const random = options.random ?? Math.random;

  if (attempt < 0) throw new Error("attempt must be >= 0");

  const raw = base * 2 ** attempt;
  const capped = Math.min(raw, cap);
  const jitter = capped * jitterRatio * random();
  return Math.round(capped + jitter);
}

/** HTTP 상태코드가 재시도할 만한지. */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status !== 501;
}

/** `Retry-After` 헤더 해석. 초 단위 정수 또는 HTTP-date 를 지원한다. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const delta = date - nowMs;
  return delta > 0 ? delta : 0;
}
