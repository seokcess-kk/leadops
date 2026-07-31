import { createHmac } from "node:crypto";
import { supabaseServer } from "./supabase";

/**
 * 서버 전용 토큰 결정 (Next 라우트 핸들러에서만 쓴다).
 *
 * ❗ **브라우저에 JWT 를 내려보내지 않는다.** 토큰은 서버에만 있고, 브라우저는
 *    `/api/gateway/*` 프록시를 호출한다.
 *
 * 우선순위:
 *   1. Supabase 세션 (httpOnly 쿠키) — 있으면 항상 이긴다
 *   2. 개발용 서명 토큰 — NODE_ENV≠production + LEADOPS_DEV_LOGIN=1 (E2E·로컬 전용.
 *      Supabase Auth 도입(2026-07-31) 때 삭제하는 대신 유지하기로 결정했다 — E2E 가
 *      실 Supabase 에 의존하지 않기 위한 격리 경로다)
 *   3. 둘 다 없으면 거부 — 조용히 폴백하지 않는다
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

/** 현재 요청에 쓸 access token. Supabase 세션이 최우선이다. */
export async function sessionToken(): Promise<string> {
  const supabase = await supabaseServer();
  if (supabase) {
    // getSession 은 쿠키의 세션을 읽는다. 서명 검증은 어차피 검수 API(HS256)가 한다.
    // 만료 직후의 빈틈은 middleware 의 getUser() 리프레시가 페이지 이동마다 메운다.
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) return token;
  }

  if (process.env["NODE_ENV"] === "production") {
    // ❗ 운영에서 개발용 토큰이 발급되면 누구나 검수자가 된다. 조용히 폴백하지 않는다.
    throw new AuthUnavailableError("세션이 없습니다. 다시 로그인하세요.");
  }
  if (process.env["LEADOPS_DEV_LOGIN"] !== "1") {
    throw new AuthUnavailableError(
      "세션이 없고 개발용 로그인도 꺼져 있습니다. 로그인하거나 LEADOPS_DEV_LOGIN=1 을 설정하세요.",
    );
  }
  return devToken();
}

/** API 서버 주소. 서버에서만 읽는다 (브라우저에 노출할 이유가 없다). */
export function apiBaseUrl(): string {
  return process.env["LEADOPS_API_URL"] ?? "http://127.0.0.1:8792";
}
