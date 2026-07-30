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

  /**
   * 상태 전이 (admin).
   *
   * ❗ `received` 로 되돌리는 전이는 없다. 접수 시각·기한이 사실이어야 하고, 되돌릴 수 있으면
   *    "10일 내 처리" 를 계산하는 기준이 사라진다. RPC 가 이것을 강제한다.
   */
  router.post("/api/privacy/requests/:id/advance", async (ctx: Ctx) => {
    const body = await ctx.body<{ status?: unknown; note?: unknown }>();
    const status = typeof body.status === "string" ? body.status : "";
    if (!["in_progress", "on_hold", "completed", "rejected"].includes(status)) {
      throw badRequest("status 는 in_progress·on_hold·completed·rejected 중 하나여야 합니다");
    }
    const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim() : null;

    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ advance_privacy_request: unknown }>>`
      select public.advance_privacy_request(${ctx.params["id"]!}, ${status}, ${note})
    `);
    return { data: rows[0]!.advance_privacy_request };
  });

  /**
   * 열람 보고서 (admin).
   *
   * ❗ 마스킹하지 않는다. 열람권은 본인 확인을 거친 정보주체가 자기 정보를 보는 권리이므로
   *    가린 채로 주면 이행한 것이 아니다. 대신 조회 자체가 감사 로그에 남는다.
   * ❗ **GET 이 아니라 POST 다.** 감사 기록을 남기는 쓰기 동작이고, GET 으로 두면 브라우저
   *    프리페치·프록시 캐시가 열람 기록을 만들어 낸다.
   */
  router.post("/api/privacy/requests/:id/access-report", async (ctx: Ctx) => {
    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ privacy_access_report: unknown }>>`
      select public.privacy_access_report(${ctx.params["id"]!})
    `);
    return { data: rows[0]!.privacy_access_report };
  });

  /**
   * 삭제·처리정지 **집행** (admin).
   *
   * ❗ 여기가 실제로 데이터를 파기하고 접촉을 영구 차단하는 지점이다. 되돌릴 수 없다.
   *    무엇을 했는지는 `actions_taken` 에 누적되고 감사 로그에도 남는다.
   * ❗ `legal_hold` 가 걸린 요청은 RPC 가 `409 legal_hold` 로 거절한다 — 보존 의무가 있는
   *    자료를 삭제 요청으로 지우면 그 자체가 위법이다.
   */
  router.post("/api/privacy/requests/:id/execute", async (ctx: Ctx) => {
    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ execute_privacy_request: unknown }>>`
      select public.execute_privacy_request(${ctx.params["id"]!})
    `);
    return { data: rows[0]!.execute_privacy_request };
  });

  /** 용량 리포트 (admin). 보존기간을 조정할 근거를 준다. */
  router.get("/api/capacity", async (ctx: Ctx) => {
    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ capacity_report: unknown }>>`
      select public.capacity_report()
    `);
    return { data: rows[0]!.capacity_report };
  });

  return router;
}
