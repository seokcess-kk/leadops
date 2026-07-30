import { createHmac } from "node:crypto";

/**
 * 서버 전용 토큰 발급 (Next 라우트 핸들러에서만 쓴다).
 *
 * ❗ **브라우저에 JWT 를 내려보내지 않는다.** 토큰은 서버에만 있고, 브라우저는
 *    `/api/gateway/*` 프록시를 호출한다. 토큰이 클라이언트 번들이나 localStorage 에
 *    들어가면 XSS 하나로 검수 권한이 유출된다.
 *
 * ⚠️ 현재 Supabase Auth 프로젝트가 없다. 그래서 개발용으로 **서버가 직접 토큰을 만든다.**
 *    이것은 인증이 아니라 인증의 자리표시자이며, 아래 조건이 모두 맞아야만 동작한다:
 *
 *      NODE_ENV !== "production"
 *      LEADOPS_DEV_LOGIN === "1"
 *      SUPABASE_JWT_SECRET · LEADOPS_DEV_USER_ID 존재
 *
 *    운영에서는 켜지지 않는다. Supabase Auth 를 붙이면 `sessionToken()` 이 세션 쿠키에서
 *    access token 을 읽는 구현으로 바뀌고, 이 개발 경로는 삭제한다.
 */

export class AuthUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`인증을 사용할 수 없습니다: ${reason}`);
    this.name = "AuthUnavailableError";
  }
}

/** 개발용 토큰 수명. 짧게 둬서 유출돼도 오래 쓰이지 못하게 한다. */
const DEV_TTL_SEC = 15 * 60;

function devToken(): string {
  const secret = process.env["SUPABASE_JWT_SECRET"];
  const sub = process.env["LEADOPS_DEV_USER_ID"];
  if (!secret) throw new AuthUnavailableError("SUPABASE_JWT_SECRET 이 없습니다");
  if (!sub) throw new AuthUnavailableError("LEADOPS_DEV_USER_ID 가 없습니다");

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub, role: "authenticated", iat: now, exp: now + DEV_TTL_SEC }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * 현재 요청에 쓸 access token.
 *
 * 앞으로 Supabase 세션을 붙일 지점이다. 지금은 개발 경로만 있다.
 */
export function sessionToken(): string {
  if (process.env["NODE_ENV"] === "production") {
    // ❗ 운영에서 개발용 토큰이 발급되면 누구나 검수자가 된다. 조용히 폴백하지 않는다.
    throw new AuthUnavailableError(
      "운영 환경에는 인증이 구성되지 않았습니다. Supabase Auth 를 연결하세요.",
    );
  }
  if (process.env["LEADOPS_DEV_LOGIN"] !== "1") {
    throw new AuthUnavailableError(
      "개발용 로그인이 꺼져 있습니다. LEADOPS_DEV_LOGIN=1 과 LEADOPS_DEV_USER_ID 를 설정하세요.",
    );
  }
  return devToken();
}

/** API 서버 주소. 서버에서만 읽는다 (브라우저에 노출할 이유가 없다). */
export function apiBaseUrl(): string {
  return process.env["LEADOPS_API_URL"] ?? "http://127.0.0.1:8792";
}
