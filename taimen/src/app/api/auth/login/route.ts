import { supabaseServer } from "@/lib/server/supabase";

/**
 * 서버 로그인. signInWithPassword 가 성공하면 @supabase/ssr 이 setAll 어댑터를 통해
 * 세션을 httpOnly 쿠키로 저장한다 — 응답 본문에 토큰이 실리지 않는다.
 */

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function POST(req: Request): Promise<Response> {
  const supabase = await supabaseServer();
  if (!supabase) {
    // env 미구성 — 이 배포에는 Supabase 로그인이 없다. 숨기지 않고 알린다.
    return json(503, {
      error: { code: "auth_unconfigured", message: "이 환경에는 Supabase 인증이 구성되지 않았습니다." },
    });
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: { code: "bad_request", message: "요청 본문이 JSON 이 아닙니다." } });
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return json(400, { error: { code: "bad_request", message: "이메일과 비밀번호를 입력하세요." } });
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // 자격 증명 오류가 아닌 것(레이트리밋·업스트림 장애)은 구분해 알린다 —
    // "비밀번호 오류" 로 위장하면 운영 진단이 불가능하다. 계정 탐색 방지는 4xx 자격 오류에만 적용.
    if (error.status === 429 || (error.status !== undefined && error.status >= 500)) {
      return json(502, {
        error: { code: "auth_upstream_error", message: "인증 서버가 응답하지 않습니다. 잠시 후 다시 시도하세요." },
      });
    }
    // 계정 존재 여부를 구분해 주지 않는다 — 계정 탐색(enumeration)을 막는다.
    return json(401, {
      error: { code: "invalid_credentials", message: "이메일 또는 비밀번호가 올바르지 않습니다." },
    });
  }
  return json(200, { data: { ok: true } });
}
