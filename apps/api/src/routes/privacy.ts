import { badRequest, forbidden, pageLimit, Router, type Ctx } from "../http";
import type { Session } from "../session";

/**
 * 개인정보 요청 접수·조회 (F-08).
 *
 * ❗ 접수는 **admin 전용이 아니다.** 열람·삭제·처리정지는 정보주체의 법정 권리이고,
 *    접수 자체를 관리자로 제한하면 권리 행사를 막는 것이 된다. 대신 **목록 조회는 admin
 *    전용**이다 — 요청자 식별자가 다른 사람에게 보이면 그 자체가 유출이다.
 *
 * ❗ 기한(10일)은 RPC 가 접수 시점에 못 박는다. 화면에서 계산하지 않는다.
 */

export interface PrivacyDeps {
  session: Session;
}

const KINDS = new Set(["access", "delete", "suspend", "correct"]);

export function privacyRoutes(deps: PrivacyDeps): Router {
  const router = new Router();

  router.post("/api/privacy/requests", async (ctx: Ctx) => {
    const body = await ctx.body<{ kind?: unknown; subject?: unknown; note?: unknown }>();
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!KINDS.has(kind)) throw badRequest(`kind 는 ${[...KINDS].join(", ")} 중 하나여야 합니다`);

    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    if (subject === "") throw badRequest("subject 가 필요합니다");
    if (subject.length > 320) throw badRequest("subject 가 너무 깁니다");
    const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim() : null;

    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ create_privacy_request: unknown }>>`
      select public.create_privacy_request(${kind}, ${subject}, ${note})
    `);
    return { data: rows[0]!.create_privacy_request };
  });

  router.get("/api/privacy/requests", async (ctx: Ctx) => {
    if (!(await deps.session.isAdmin(ctx.userId))) throw forbidden("admin 권한이 필요합니다");
    const limit = pageLimit(ctx.url);
    const openOnly = ctx.url.searchParams.get("open") === "1";

    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<Record<string, unknown>>>`
      select p.id, p.kind, p.subject_identifier, p.status, p.legal_hold, p.hold_reason,
             p.received_at, p.due_at, p.completed_at, p.actions_taken,
             p.company_id, c.name as company_name,
             (p.due_at < now() and p.completed_at is null) as overdue
      from privacy_requests p
      left join companies c on c.id = p.company_id
      where (${openOnly}::boolean is not true
             or p.status in ('received', 'in_progress', 'on_hold'))
      order by p.due_at
      limit ${limit}
    `);
    return { data: rows, meta: { limit } };
  });

  return router;
}
