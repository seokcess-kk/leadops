import { AuthUnavailableError, apiBaseUrl, sessionToken } from "@/lib/server/token";

/**
 * 검수 API 프록시.
 *
 * 브라우저 → 이 핸들러 → 검수 API. 이렇게 두는 이유:
 *
 *  1. **토큰이 브라우저에 내려가지 않는다.** 토큰을 클라이언트에 두면 XSS 하나로
 *     검수 권한이 유출된다. 여기서만 붙인다.
 *  2. CORS 가 필요 없다 — 브라우저에서 보면 같은 출처다.
 *  3. 나중에 Supabase Auth 를 붙일 때 바꿀 곳이 이 파일 하나다.
 *
 * ❗ 경로를 그대로 넘기지 않고 **허용 목록**으로 좁힌다. 열어 두면 이 프록시가
 *    API 의 모든 엔드포인트에 대한 무인증 통로가 된다.
 */

export const dynamic = "force-dynamic";

/** 프록시가 통과시킬 경로. `:id` 자리는 세그먼트 하나를 뜻한다. */
const ALLOWED: ReadonlyArray<{ method: string; pattern: readonly string[] }> = [
  { method: "GET", pattern: ["api", "me"] },
  { method: "GET", pattern: ["api", "review"] },
  { method: "GET", pattern: ["api", "review", ":id"] },
  { method: "POST", pattern: ["api", "review", ":id", "contact-email"] },
  { method: "POST", pattern: ["api", "review", ":id", "decision"] },
  { method: "POST", pattern: ["api", "review", "bulk-decision"] },
  { method: "POST", pattern: ["api", "review", ":id", "competitors"] },
  { method: "GET", pattern: ["api", "leads"] },
  { method: "GET", pattern: ["api", "leads", "export"] },
  { method: "GET", pattern: ["api", "runs"] },
  { method: "GET", pattern: ["api", "runs", ":id"] },
  { method: "POST", pattern: ["api", "runs"] },
  { method: "POST", pattern: ["api", "runs", ":id", "retry"] },
  { method: "POST", pattern: ["api", "runs", ":id", "cancel"] },
  { method: "GET", pattern: ["api", "settings"] },
  { method: "PUT", pattern: ["api", "settings", ":key"] },
  { method: "GET", pattern: ["api", "costs"] },
  { method: "GET", pattern: ["api", "industries"] },
  { method: "GET", pattern: ["api", "keywords"] },
  { method: "POST", pattern: ["api", "keywords", ":id", "approve"] },
  { method: "GET", pattern: ["api", "privacy", "requests"] },
  { method: "POST", pattern: ["api", "privacy", "requests"] },
  { method: "POST", pattern: ["api", "privacy", "requests", ":id", "advance"] },
  { method: "POST", pattern: ["api", "privacy", "requests", ":id", "access-report"] },
  { method: "POST", pattern: ["api", "privacy", "requests", ":id", "execute"] },
  { method: "GET", pattern: ["api", "capacity"] },
];

function allowed(method: string, segments: readonly string[]): boolean {
  return ALLOWED.some((entry) => {
    if (entry.method !== method) return false;
    if (entry.pattern.length !== segments.length) return false;
    return entry.pattern.every((part, i) => part.startsWith(":") || part === segments[i]);
  });
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function forward(req: Request, segments: string[]): Promise<Response> {
  if (!allowed(req.method, segments)) {
    return json(404, { error: { code: "not_found", message: `${req.method} /${segments.join("/")}` } });
  }

  let token: string;
  try {
    token = await sessionToken();
  } catch (err) {
    if (err instanceof AuthUnavailableError) {
      return json(401, { error: { code: "auth_unavailable", message: err.message } });
    }
    throw err;
  }

  const incoming = new URL(req.url);
  const target = new URL(`/${segments.join("/")}`, apiBaseUrl());
  target.search = incoming.search;

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: await req.text() }),
      cache: "no-store",
    });
    // 상태 코드를 그대로 넘긴다 — 409(상한 도달)·422(MX 미통과)를 UI 가 구분해야 한다.
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return json(502, {
      error: {
        code: "api_unreachable",
        message: `검수 API 에 연결할 수 없습니다 (${apiBaseUrl()}). 서버가 떠 있는지 확인하세요.`,
      },
    });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return forward(req, (await ctx.params).path);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return forward(req, (await ctx.params).path);
}

export async function PUT(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return forward(req, (await ctx.params).path);
}
