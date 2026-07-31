import { createServer, type Server } from "node:http";
import { configError, type Logger } from "@leadops/core";
import type { MxResolver } from "@leadops/http";
import type { Sql } from "postgres";
import { verifyInternalSignature } from "./hmac";
import { makeCtx, readRawBody, Router, sendJson, toApiError, type Handler } from "./http";
import { bearerToken, verifyJwt } from "./jwt";
import { industryRoutes } from "./routes/industries";
import { internalRoutes } from "./routes/internal";
import { leadRoutes } from "./routes/leads";
import { meRoutes } from "./routes/me";
import { privacyRoutes } from "./routes/privacy";
import { reviewRoutes } from "./routes/review";
import { runRoutes } from "./routes/runs";
import { settingsRoutes } from "./routes/settings";
import { Session } from "./session";

/**
 * 검수 API 서버 (설계서 7.2).
 *
 * ❗ 인증을 라우터보다 **먼저** 통과시킨다. 라우트마다 검사하게 만들면 새 라우트를 추가할
 *    때 빠뜨릴 수 있고, 빠뜨린 것을 알아차릴 방법이 없다.
 *
 * ❗ 모든 사용자 작업은 `authenticated` 역할로 내려가 RLS 아래에서 실행된다
 *    (`session.ts` 참고). 소유자 권한으로 새는 경로가 없어야 한다.
 */

export interface ApiOptions {
  sql: Sql;
  jwtSecret: string;
  logger: Logger;
  /** 테스트에서 DNS 를 대체한다. 지정하지 않으면 실제 DNS 를 쓴다. */
  resolver?: MxResolver | undefined;
  /**
   * pg_cron 트리거 서명 비밀 (`POST /internal/run`).
   *
   * ❗ 없으면 그 경로가 **비활성**이다 (401 `trigger_unavailable`). 조용히 열어 두면
   *    누구나 실행을 만들어 쿼터와 비용을 소진시킬 수 있다.
   */
  internalSecret?: string | undefined;
}

/** 인증 없이 접근할 수 있는 경로. 목록을 좁게 유지한다. */
const PUBLIC_PATHS = new Set(["/health"]);

/**
 * JWT 대신 **HMAC 서명**으로 통과하는 경로.
 *
 * ❗ 사용자 컨텍스트가 없다 (`auth.uid()` 가 없다). 그래서 이 경로의 핸들러는 RLS 아래가
 *    아니라 서버 권한으로 동작하고, 목록을 좁게 유지하는 것이 유일한 방어선이다.
 */
const SIGNED_PATHS = new Set(["/internal/run"]);

/** 헤더 하나를 문자열로. 중복 헤더는 배열로 오므로 첫 값만 본다. */
function header(req: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createApi(options: ApiOptions): Server {
  if (!options.jwtSecret) {
    throw configError(
      "SUPABASE_JWT_SECRET 이 필요합니다. Supabase 프로젝트 설정의 JWT Secret 을 넣으세요.",
    );
  }
  const session = new Session(options.sql);
  const routers: Router[] = [
    reviewRoutes({ session, resolver: options.resolver }),
    leadRoutes({ session }),
    meRoutes({ session }),
    runRoutes({ session }),
    settingsRoutes({ session }),
    industryRoutes({ session }),
    privacyRoutes({ session }),
    internalRoutes({ session }),
  ];

  const resolveRoute = (method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined => {
    for (const router of routers) {
      const hit = router.match(method, pathname);
      if (hit) return hit;
    }
    return undefined;
  };

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      try {
        if (PUBLIC_PATHS.has(pathname)) {
          sendJson(res, 200, { data: { ok: true } });
          return;
        }

        // ── HMAC 서명 경로 (pg_cron 트리거) — 라우팅보다 먼저 검증한다 ──
        if (SIGNED_PATHS.has(pathname)) {
          // ❗ 원문을 여기서 읽는다. 스트림은 한 번만 읽히므로 ctx 에 그대로 넘긴다.
          const raw = await readRawBody(req);
          verifyInternalSignature(
            options.internalSecret,
            { signature: header(req, "x-leadops-signature"), timestamp: header(req, "x-leadops-timestamp") },
            raw,
          );

          const signedHit = resolveRoute(req.method ?? "GET", pathname);
          if (!signedHit) {
            sendJson(res, 404, { error: { code: "not_found", message: `${req.method} ${pathname}` } });
            return;
          }
          // ❗ 사용자 컨텍스트가 없다. 빈 `userId` 는 `auth.uid()` 를 null 로 만들어, 이 경로의
          //    핸들러가 실수로 `asUser` 를 부르면 RPC 가 `unauthenticated` 로 거절한다 —
          //    조용히 다른 사람 권한으로 실행되는 일이 없다.
          const signedCtx = makeCtx(req, res, url, signedHit.params, "", options.logger, raw);
          sendJson(res, 200, await signedHit.handler(signedCtx));
          return;
        }

        // ── 인증 (라우팅보다 먼저) ──
        const claims = verifyJwt(bearerToken(req.headers.authorization), options.jwtSecret);

        const hit = resolveRoute(req.method ?? "GET", pathname);
        if (!hit) {
          sendJson(res, 404, { error: { code: "not_found", message: `${req.method} ${pathname}` } });
          return;
        }

        // ❗ 사용자 id 는 요청 컨텍스트로만 흐른다. 공유 변수에 두면 동시 요청이 섞인다.
        const ctx = makeCtx(req, res, url, hit.params, claims.sub, options.logger);
        const payload = await hit.handler(ctx);
        sendJson(res, 200, payload);
      } catch (err) {
        const apiError = toApiError(err);
        if (apiError.status >= 500) {
          // 5xx 는 우리 버그다. 원문을 남긴다 (응답에는 넣지 않는다).
          options.logger.error("api.error", {
            method: req.method,
            path: pathname,
            error: err instanceof Error ? err.message : String(err),
          });
        } else {
          options.logger.warn("api.rejected", { method: req.method, path: pathname, code: apiError.code });
        }
        sendJson(res, apiError.status, {
          error: {
            code: apiError.code,
            message: apiError.message,
            ...(apiError.details === undefined ? {} : { details: apiError.details }),
          },
        });
      }
    })();
  });
}
