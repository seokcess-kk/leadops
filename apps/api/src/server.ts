import { createServer, type Server } from "node:http";
import { configError, type Logger } from "@leadops/core";
import type { MxResolver } from "@leadops/http";
import type { Sql } from "postgres";
import { makeCtx, Router, sendJson, toApiError, type Handler } from "./http";
import { bearerToken, verifyJwt } from "./jwt";
import { industryRoutes } from "./routes/industries";
import { leadRoutes } from "./routes/leads";
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
}

/** 인증 없이 접근할 수 있는 경로. 목록을 좁게 유지한다. */
const PUBLIC_PATHS = new Set(["/health"]);

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
    runRoutes({ session }),
    settingsRoutes({ session }),
    industryRoutes({ session }),
    privacyRoutes({ session }),
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
