import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * 세션 리프레시 + 비로그인 가드.
 *
 * - Supabase 세션이 만료 임박이면 getUser() 가 리프레시하고 Set-Cookie 로 갱신한다
 *   (httpOnly 유지 — setAll 에서 강제).
 * - 세션도 dev login 도 없으면 /login 으로 보낸다. dev login(E2E·로컬)은 가드를 통과해야
 *   로그인 화면에 막히지 않는다.
 * - `supabaseServer()`(next/headers) 는 middleware 에서 못 쓴다 — 요청/응답 쿠키 어댑터를
 *   여기서 직접 만든다.
 */

const PUBLIC_PATHS = [/^\/login$/, /^\/api\/auth\//, /^\/api\/gateway\//];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_ANON_KEY"];
  let hasSession = false;

  if (url && key) {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, {
              ...options,
              httpOnly: true,
              sameSite: "lax",
              secure: process.env.NODE_ENV === "production",
            });
          }
          // ❗ @supabase/ssr 의 setAll 2번째 인자(캐시 방지 헤더)는 우리가 응답 레벨에서
          //    직접 처리한다 — 쿠키 갱신이 일어난 이 응답에 cache-control 을 강제한다.
          response.headers.set("cache-control", "private, no-store");
        },
      },
    });
    // ❗ getSession 이 아니라 getUser — 만료 세션의 리프레시를 유발하는 호출이다.
    const { data } = await supabase.auth.getUser();
    hasSession = data.user !== null;
  }

  const pathname = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((re) => re.test(pathname));
  const devLogin =
    process.env["LEADOPS_DEV_LOGIN"] === "1" && process.env.NODE_ENV !== "production";

  if (!hasSession && !devLogin && !isPublic) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (hasSession && pathname === "/login") {
    return NextResponse.redirect(new URL("/today", request.url));
  }
  return response;
}

export const config = {
  // 정적 자산은 가드 대상이 아니다.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts).*)"],
};
