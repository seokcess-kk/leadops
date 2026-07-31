import { badRequest, Router, type Ctx } from "../http";
import type { Session } from "../session";

/**
 * 로그인 사용자 프로필. 사이드바가 하드코딩 대신 이 값을 쓴다.
 *
 * RLS `profiles_read`(본인 또는 admin)가 본인 행 조회를 허용하므로 세션 컨텍스트
 * 그대로 질의한다 — 서버 권한으로 우회하지 않는다.
 */

export interface MeDeps {
  session: Session;
}

export function meRoutes(deps: MeDeps): Router {
  const router = new Router();

  router.get("/api/me", async (ctx: Ctx) => {
    const [row] = await deps.session.asUser(ctx.userId, (tx) => tx<
      Array<{ id: string; email: string; role: string }>
    >`
      select id, email::text as email, role::text as role
      from profiles where id = ${ctx.userId}
    `);
    // auth.users 트리거가 profiles 를 만들므로 정상 경로에서는 항상 있다.
    if (!row) throw badRequest("프로필을 찾을 수 없습니다");
    return { data: row };
  });

  return router;
}
