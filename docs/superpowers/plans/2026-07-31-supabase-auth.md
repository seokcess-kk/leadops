# Supabase Auth 연동 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** taimen 에 서버 전용 Supabase Auth(이메일+비번, httpOnly 쿠키)를 붙이고 `sessionToken()` 을 세션 우선으로 개편한다 — 브라우저에는 토큰도 supabase-js 도 내려가지 않는다.

**Architecture:** 로그인·로그아웃·세션 읽기는 전부 서버(route handler·middleware)에서 `@supabase/ssr` 로 처리. 세션 쿠키는 httpOnly. dev login 경로는 가드 그대로 유지(E2E 격리)하되 Supabase 세션이 있으면 항상 우선. API·DB 무변경. 스펙: `docs/superpowers/specs/2026-07-31-supabase-auth-design.md`

**Tech Stack:** Next.js 16 (App Router · `src/middleware.ts` — Next 16 은 `middleware`·`proxy` 파일명 둘 다 인식, 호환 관례 사용) · `@supabase/ssr` + `@supabase/supabase-js` (taimen 독립 워크스페이스, **서버 코드에서만 import**) · TypeScript 6 고정

## Global Constraints

- **브라우저 번들에 `@supabase/*` 불포함** — 클라이언트 컴포넌트에서 import 금지. env 는 `SUPABASE_URL`·`SUPABASE_ANON_KEY` (서버 전용 — `NEXT_PUBLIC_` 접두사 금지)
- **세션 쿠키는 httpOnly** — setAll 어댑터에서 강제
- **Supabase 세션이 있으면 dev login 보다 항상 우선**
- dev login 가드 무변경: `NODE_ENV !== "production"` + `LEADOPS_DEV_LOGIN === "1"` + `LEADOPS_DEV_USER_ID`
- env 미구성(`SUPABASE_URL` 없음) 시 Supabase 경로를 건너뛰고 dev/401 로 — 로컬 개발은 지금처럼 동작
- 가입 UI 없음 · 오류는 코드와 함께 표시 (가짜 성공 금지) · 카피에 "검색 노출·순위·점유율" 계열 표현 금지
- taimen 검증: `taimen` 디렉터리에서 `pnpm typecheck` (루트 verify 는 taimen 을 안 덮는다)
- 커밋 메시지 끝: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: 서버 Auth 기반 — 의존성 · supabase 팩토리 · sessionToken 개편

**Files:**
- Modify: `taimen/package.json` (의존성 — `pnpm add` 로)
- Create: `taimen/src/lib/server/supabase.ts`
- Modify: `taimen/src/lib/server/token.ts` (전면 개편)
- Modify: `taimen/src/app/api/gateway/[...path]/route.ts:66-75` (await 반영)

**Interfaces:**
- Produces: `supabaseServer(): Promise<SupabaseClient | null>` (env 미구성 시 null) · `sessionToken(): Promise<string>` (세션 → dev → throw AuthUnavailableError). Task 2·3 이 `supabaseServer` 를 재사용한다.

- [ ] **Step 1: 의존성 설치**

```powershell
Set-Location C:\Users\assag\solution\leadops\taimen; pnpm add @supabase/ssr @supabase/supabase-js
```

- [ ] **Step 2: 서버 팩토리** — `taimen/src/lib/server/supabase.ts`:

```typescript
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
```

- [ ] **Step 3: token.ts 개편** — 파일 전체를 다음으로 교체:

```typescript
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
```

- [ ] **Step 4: 게이트웨이 await 반영** — `route.ts` 의 `forward()` 안 (66-75행):

```typescript
  let token: string;
  try {
    token = await sessionToken();
  } catch (err) {
    if (err instanceof AuthUnavailableError) {
      return json(401, { error: { code: "auth_unavailable", message: err.message } });
    }
    throw err;
  }
```

- [ ] **Step 5: typecheck**

Run: `taimen` 디렉터리에서 `pnpm typecheck` → PASS

- [ ] **Step 6: 커밋**

```bash
git add taimen/package.json taimen/pnpm-lock.yaml taimen/src/lib/server
git add "taimen/src/app/api/gateway/[...path]/route.ts"
git commit -m "서버 전용 Supabase Auth 기반 — supabaseServer 팩토리 · sessionToken 세션 우선"
```

---

### Task 2: 로그인·로그아웃 라우트 + /login 페이지 + 사이드바 로그아웃

**Files:**
- Create: `taimen/src/app/api/auth/login/route.ts`
- Create: `taimen/src/app/api/auth/logout/route.ts`
- Create: `taimen/src/app/login/page.tsx`
- Modify: `taimen/src/components/shell/Sidebar.tsx:99-117` (사용자 블록에 로그아웃)

**Interfaces:**
- Consumes: `supabaseServer()` (Task 1)
- Produces: `POST /api/auth/login` `{ email, password }` → 200 `{ data: { ok: true } }` | 4xx `{ error: { code, message } }` · `POST /api/auth/logout` → 200

- [ ] **Step 1: 로그인 라우트** — `login/route.ts`:

```typescript
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
    // 계정 존재 여부를 구분해 주지 않는다 — 계정 탐색(enumeration)을 막는다.
    return json(401, {
      error: { code: "invalid_credentials", message: "이메일 또는 비밀번호가 올바르지 않습니다." },
    });
  }
  return json(200, { data: { ok: true } });
}
```

- [ ] **Step 2: 로그아웃 라우트** — `logout/route.ts`:

```typescript
import { supabaseServer } from "@/lib/server/supabase";

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function POST(): Promise<Response> {
  const supabase = await supabaseServer();
  // 미구성이어도 로그아웃은 성공으로 답한다 — 지울 세션 자체가 없다.
  if (supabase) await supabase.auth.signOut();
  return json(200, { data: { ok: true } });
}
```

- [ ] **Step 3: 로그인 페이지** — `login/page.tsx` (클라이언트 컴포넌트 — Supabase import 없음,
  fetch 만 쓴다. 디자인 토큰은 기존 유틸리티 클래스):

```tsx
"use client";

import { useState } from "react";

/**
 * 로그인 — 내부 검수 콘솔이라 가입 링크가 없다 (계정은 관리자가 만든다).
 * 오류는 코드와 함께 그대로 보여 준다 — 가짜 성공 없음.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await res.json()) as { error?: { code: string; message: string } };
      if (!res.ok || payload.error) {
        setError(`${payload.error?.message ?? "로그인에 실패했습니다."} (${payload.error?.code ?? res.status})`);
        return;
      }
      window.location.href = "/today";
    } catch {
      setError("서버에 연결할 수 없습니다. (network_error)");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas">
      <form
        onSubmit={submit}
        className="flex w-[360px] flex-col gap-5 rounded-card border border-line bg-canvas p-8"
      >
        <div className="flex flex-col gap-1">
          <span className="flex items-end gap-1.5">
            <span className="display-num text-[28px] uppercase leading-none text-fg">
              Lead<span className="text-mint">Ops</span>
            </span>
            <span aria-hidden className="mb-[3px] block h-[5px] w-[5px] bg-mint" />
          </span>
          <span className="mono-label text-[9px]">Outbound Ops Console</span>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="mono-label text-[9px]">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 rounded-block border border-line bg-subtle px-3 text-sm text-fg outline-none focus:border-mint"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="mono-label text-[9px]">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10 rounded-block border border-line bg-subtle px-3 text-sm text-fg outline-none focus:border-mint"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-block bg-violet px-3 py-2 text-[12px] text-fg">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="h-10 rounded-full bg-mint text-sm font-semibold text-ink transition-opacity disabled:opacity-50"
        >
          {busy ? "확인 중…" : "로그인"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: 사이드바 로그아웃** — `Sidebar.tsx` 사용자 블록(99-117행 부근)의 이메일/역할
  `div` 다음, 블록 안에 우측 버튼 추가:

```tsx
        <button
          type="button"
          aria-label="로그아웃"
          onClick={() => {
            void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
              window.location.href = "/login";
            });
          }}
          className="ml-auto shrink-0 rounded-full px-2 py-1 font-mono text-[9px] uppercase tracking-[0.15em] text-fg-3 transition-colors hover:text-hoverlink"
        >
          Out
        </button>
```

- [ ] **Step 5: typecheck**

Run: `taimen` 디렉터리에서 `pnpm typecheck` → PASS

- [ ] **Step 6: 커밋**

```bash
git add taimen/src/app/api/auth taimen/src/app/login taimen/src/components/shell/Sidebar.tsx
git commit -m "로그인·로그아웃 — 서버 라우트 · /login 화면 · 사이드바 Out 버튼"
```

---

### Task 3: middleware 가드 + E2E 회귀 + 런북

**Files:**
- Create: `taimen/src/middleware.ts`
- Modify: `docs/07-runbook.md:33-41` (1.3 환경변수 표)

**Interfaces:**
- Consumes: 없음 (middleware 는 자체 쿠키 어댑터 — `supabaseServer` 는 next/headers 기반이라 못 쓴다)

- [ ] **Step 1: middleware** — `taimen/src/middleware.ts`:

```typescript
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
```

- [ ] **Step 2: 런북 1.3 표에 행 추가** — `docs/07-runbook.md` 환경변수 표의
  `LEADOPS_API_URL` 행 다음:

```markdown
| `SUPABASE_URL` · `SUPABASE_ANON_KEY` | taimen 서버 (Supabase Auth 로그인·세션) | Supabase 로그인 경로 비활성 — dev login 또는 401 |
```

- [ ] **Step 3: typecheck + E2E 회귀**

Run: `taimen` 에서 `pnpm typecheck` → PASS
Run: 루트에서 `pnpm e2e` → 13건 PASS — dev login 경로가 middleware 에 막히지 않음을 실증
(⚠️ E2E 는 SUPABASE_URL 없이 뜨므로 Supabase 분기는 건너뛰고 devLogin 분기가 통과시켜야 한다)

- [ ] **Step 4: 커밋**

```bash
git add taimen/src/middleware.ts docs/07-runbook.md
git commit -m "middleware — 세션 리프레시·비로그인 가드 (dev login 통과) · 런북 env 표"
```

---

## 계획 밖 (컨트롤러·발주자 후속 — SDD 태스크 아님)

1. (발주자) Supabase Dashboard → Authentication → Add user 로 `seokcess@glitzy.kr` 생성
2. (컨트롤러) `profiles` 자동 생성 확인 → admin 승격 SQL 실행 (런북 1.2)
3. (컨트롤러+발주자) **스테이징 관통 검증** (스펙 완료 기준): 로컬 taimen 을
   `SUPABASE_URL`·`SUPABASE_ANON_KEY`·`SUPABASE_JWT_SECRET`(prod)·`LEADOPS_DEV_LOGIN` 제거
   구성으로, API 를 `API_DATABASE_URL`(Supabase pooler)·prod secret 으로 띄워 —
   실로그인 → `/today` → 사이드바 admin 표시 → 게이트웨이 200 → 로그아웃 → `/login`
   리다이렉트 확인 + 실토큰 `alg=HS256` 확증

## Self-Review 결과

- **스펙 커버리지**: 인증 흐름(로그인/로그아웃/미들웨어/sessionToken 우선순위) = Task 1·2·3.
  httpOnly·서버 전용·env 규칙 = Global Constraints + 각 코드. dev 경로 유지·세션 우선 = Task 1
  Step 3. 가입 UI 없음·오류 표시 = Task 2. 런북 = Task 3. 운영 절차·스테이징 = 계획 밖 절.
  E2E 회귀 = Task 3 Step 3.
- **플레이스홀더**: 없음 — 전 파일 전문 수록.
- **타입 일관성**: `supabaseServer(): Promise<SupabaseClient | null>` — token.ts 소비부 일치.
  `sessionToken(): Promise<string>` — gateway await 일치. 로그인 응답 봉투 `{ data: { ok } } / { error: { code, message } }` — login 페이지 소비부 일치.
