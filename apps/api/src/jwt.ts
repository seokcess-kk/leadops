import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from "node:crypto";

/**
 * Supabase Auth 가 발급한 JWT 검증 (HS256 · ES256).
 *
 * 라이브러리를 쓰지 않는 대신 **공격 케이스를 테스트로 고정한다.** JWT 검증에서
 * 실제로 사고가 나는 지점을 전부 여기서 명시적으로 막는다.
 *
 *  1. **alg 혼동** — `{"alg":"none"}` 같은 무서명 토큰을 받아들이면 검증 없이 통과한다.
 *     허용 목록(HS256·ES256)만 받고, **alg 마다 고정된 키 하나**로만 검증한다 —
 *     HS256 은 공유 시크릿, ES256 은 프로젝트 공개키. 한 키가 다른 alg 로 재해석될
 *     경로가 없다 (공개키를 HMAC 키로 쓰는 고전적 혼동 공격이 성립하지 않는다).
 *  2. **타이밍 공격** — HMAC 서명 비교를 문자열 `===` 로 하면 앞자리 일치 여부가
 *     시간으로 새어 나간다. `timingSafeEqual` 을 쓴다. (ES256 은 공개키 연산이라 해당 없음)
 *  3. **만료 미검사** — `exp` 를 요구하고 반드시 확인한다.
 *
 * ES256 은 Supabase 의 JWT signing keys 체계다 — 2026-08-03 스테이징 관통 검증에서
 * 사용자 access token 이 legacy HS256 이 아니라 ES256 으로 서명됨을 확인했다 (설계서가
 * 예고한 재확증 게이트). 공개키는 프로젝트 JWKS 의 키 JSON 을 env 로 정적 주입한다 —
 * 부팅 시 네트워크 의존이 없고, 미설정이면 ES256 토큰이 조용히 통과하는 게 아니라
 * 전부 거절된다 (fail-closed).
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

/**
 * alg 별 검증 키. 문자열 하나를 주면 HS256 시크릿으로 해석한다 (기존 호출부 호환).
 * `es256PublicJwk` 는 JWKS 의 키 객체를 JSON 문자열 그대로 넣는다
 * (`{"kty":"EC","crv":"P-256","x":"…","y":"…"}` — 공개키라 비밀이 아니다).
 */
export interface JwtKeys {
  readonly hs256Secret?: string | undefined;
  readonly es256PublicJwk?: string | undefined;
}

/** JWK 문자열 → KeyObject. 같은 문자열은 캐시한다 (요청마다 파싱하지 않는다). */
const publicKeyCache = new Map<string, KeyObject>();

function es256PublicKey(jwkJson: string): KeyObject {
  const cached = publicKeyCache.get(jwkJson);
  if (cached) return cached;

  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(jwkJson) as Record<string, unknown>;
  } catch {
    throw new JwtError("ES256 공개키(JWK)를 해석할 수 없습니다");
  }
  // 곡선·종류를 명시적으로 고정한다 — 다른 곡선의 키를 조용히 받아들이지 않는다.
  if (jwk["kty"] !== "EC" || jwk["crv"] !== "P-256") {
    throw new JwtError("ES256 공개키는 kty=EC · crv=P-256 이어야 합니다");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk as never, format: "jwk" });
  } catch {
    throw new JwtError("ES256 공개키(JWK)를 해석할 수 없습니다");
  }
  publicKeyCache.set(jwkJson, key);
  return key;
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

export function verifyJwt(token: string, keys: string | JwtKeys, nowMs: number = Date.now()): JwtClaims {
  const resolved: JwtKeys = typeof keys === "string" ? { hs256Secret: keys } : keys;
  if (!resolved.hs256Secret && !resolved.es256PublicJwk) {
    throw new JwtError("서버에 JWT 검증 키가 설정되지 않았습니다");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("형식이 올바르지 않습니다");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // ── 1. alg 허용 목록 — alg 마다 고정된 키 하나 ──
  const header = decodeSegment(headerB64);
  const alg = header["alg"];
  if (alg !== "HS256" && alg !== "ES256") throw new JwtError(`허용되지 않은 alg: ${String(alg)}`);

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, "base64url");
  } catch {
    throw new JwtError("서명을 해석할 수 없습니다");
  }

  // ── 2. 서명 ──
  if (alg === "HS256") {
    if (!resolved.hs256Secret) throw new JwtError("HS256 시크릿이 설정되지 않았습니다");
    const expected = createHmac("sha256", resolved.hs256Secret).update(`${headerB64}.${payloadB64}`).digest();
    // 길이가 다르면 timingSafeEqual 이 던진다. 길이 자체는 비밀이 아니므로 먼저 본다.
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new JwtError("서명이 일치하지 않습니다");
    }
  } else {
    if (!resolved.es256PublicJwk) throw new JwtError("ES256 공개키가 설정되지 않았습니다");
    // JOSE 의 ES256 서명은 raw R||S (64바이트, IEEE P1363) — DER 이 아니다.
    if (signature.length !== 64) throw new JwtError("서명이 일치하지 않습니다");
    const ok = verifySignature(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: es256PublicKey(resolved.es256PublicJwk), dsaEncoding: "ieee-p1363" },
      signature,
    );
    if (!ok) throw new JwtError("서명이 일치하지 않습니다");
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
