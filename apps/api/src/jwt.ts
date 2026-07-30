import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Supabase Auth 가 발급한 JWT 검증 (HS256).
 *
 * 라이브러리를 쓰지 않는 대신 **공격 케이스를 테스트로 고정한다.** HS256 검증에서
 * 실제로 사고가 나는 지점은 셋뿐이고, 셋 다 여기서 명시적으로 막는다.
 *
 *  1. **alg 혼동** — `{"alg":"none"}` 이나 `RS256` 을 받아들이면 서명 없이 통과한다.
 *     허용 목록을 두고 HS256 만 받는다.
 *  2. **타이밍 공격** — 서명 비교를 문자열 `===` 로 하면 앞자리 일치 여부가 시간으로
 *     새어 나간다. `timingSafeEqual` 을 쓴다.
 *  3. **만료 미검사** — `exp` 를 요구하고 반드시 확인한다.
 *
 * `sub` 는 그대로 `request.jwt.claim.sub` 에 들어가 RLS 의 `auth.uid()` 가 된다.
 * UUID 가 아니면 거절한다 — 캐스팅 실패를 인증 실패로 바꿔야 원인이 분명해진다.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 시계 오차 허용치. Supabase 와 우리 서버의 시각이 조금 다를 수 있다. */
const CLOCK_SKEW_SEC = 30;

export class JwtError extends Error {
  constructor(readonly reason: string) {
    super(`토큰을 검증할 수 없습니다: ${reason}`);
    this.name = "JwtError";
  }
}

export interface JwtClaims {
  readonly sub: string;
  readonly exp: number;
  readonly role?: string | undefined;
  readonly email?: string | undefined;
}

function decodeSegment(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new JwtError("세그먼트를 해석할 수 없습니다");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JwtError("세그먼트가 객체가 아닙니다");
  }
  return parsed as Record<string, unknown>;
}

export function verifyJwt(token: string, secret: string, nowMs: number = Date.now()): JwtClaims {
  if (!secret) throw new JwtError("서버에 JWT 비밀키가 설정되지 않았습니다");

  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("형식이 올바르지 않습니다");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // ── 1. alg 허용 목록 ──
  const header = decodeSegment(headerB64);
  if (header["alg"] !== "HS256") throw new JwtError(`허용되지 않은 alg: ${String(header["alg"])}`);

  // ── 2. 서명 (타이밍 안전 비교) ──
  const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signatureB64, "base64url");
  } catch {
    throw new JwtError("서명을 해석할 수 없습니다");
  }
  // 길이가 다르면 timingSafeEqual 이 던진다. 길이 자체는 비밀이 아니므로 먼저 본다.
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError("서명이 일치하지 않습니다");
  }

  // ── 3. 클레임 ──
  const payload = decodeSegment(payloadB64);
  const nowSec = Math.floor(nowMs / 1000);

  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw new JwtError("exp 가 없습니다");
  if (nowSec > exp + CLOCK_SKEW_SEC) throw new JwtError("만료되었습니다");

  const nbf = payload["nbf"];
  if (typeof nbf === "number" && nowSec + CLOCK_SKEW_SEC < nbf) throw new JwtError("아직 유효하지 않습니다");

  const sub = payload["sub"];
  if (typeof sub !== "string" || !UUID.test(sub)) throw new JwtError("sub 가 UUID 가 아닙니다");

  const role = payload["role"];
  const email = payload["email"];
  return {
    sub,
    exp,
    ...(typeof role === "string" ? { role } : {}),
    ...(typeof email === "string" ? { email } : {}),
  };
}

/** `Authorization: Bearer <token>` 에서 토큰을 꺼낸다. */
export function bearerToken(header: string | undefined): string {
  if (!header) throw new JwtError("Authorization 헤더가 없습니다");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new JwtError("Bearer 형식이 아닙니다");
  return match[1]!.trim();
}

/** 테스트·로컬 개발에서 토큰을 만든다. 운영에서는 Supabase 가 발급한다. */
export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
