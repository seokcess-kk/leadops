import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 서버 전용 Supabase 클라이언트 (route handler 용).
 *
 * ❗ **브라우저에는 Supabase 클라이언트를 두지 않는다.** 표준 브라우저 클라이언트 패턴은
 *    세션 쿠키를 JS 로 읽게 만들어, XSS 하나로 검수 권한이 유출된다 — 게이트웨이 프록시를
 *    둔 이유와 정면 충돌한다. 그래서 로그인·세션 읽기 전부 서버에서만 하고, 쿠키는
 *    httpOnly 로 강제한다.
 *
 * ❗ env 미구성이면 null — 조용한 폴백이 아니라 "Supabase 경로 없음" 이다. 호출자
 *    (sessionToken)가 dev 경로 또는 401 로 흐른다. 로컬 개발은 env 없이 지금처럼 동작한다.
 */
export async function supabaseServer(): Promise<SupabaseClient | null> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_ANON_KEY"];
  if (!url || !key) return null;

  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) {
          // ❗ httpOnly 강제 — 브라우저 JS 가 세션을 읽을 수 없어야 한다.
          cookieStore.set(name, value, {
            ...options,
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
          });
        }
      },
    },
  });
}
