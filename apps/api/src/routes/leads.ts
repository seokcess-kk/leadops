import { badRequest, pageLimit, Router, type Ctx } from "../http";

type Row = Record<string, unknown>;
import type { Session } from "../session";

/**
 * 승인 리드 API (설계서 7.2).
 *
 * export 는 RPC 가 게이트를 강제한다 — 접촉 근거·수신거부·개인정보 요청·보유기간이
 * 조건을 만족하지 않는 리드는 애초에 나오지 않고, 제외된 건수가 감사 로그에 남는다.
 * API 는 날짜만 옮긴다.
 */

export interface LeadDeps {
  session: Session;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const date = (value: string | null, field: string): string => {
  if (value === null || !DATE.test(value)) throw badRequest(`${field} 는 YYYY-MM-DD 형식이어야 합니다`);
  return value;
};

export function leadRoutes(deps: LeadDeps): Router {
  const router = new Router();

  router.get("/api/leads", async (ctx: Ctx) => {
    const limit = pageLimit(ctx.url);
    // 발송 상태(READY·SENT…)는 Outreach 모듈의 것이고 아직 DB 에 없다.
    // 여기서 필터할 수 있는 것은 export 여부뿐이다.
    const exported = ctx.url.searchParams.get("exported");
    if (exported !== null && exported !== "true" && exported !== "false") {
      throw badRequest("exported 는 true 또는 false 여야 합니다");
    }

    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Row[]>`
      select l.id, l.approval_date, l.approved_industry, l.score::float8 as score,
             l.export_status, l.export_count, l.use_scope,
             l.contact_legal_basis, l.retention_until,
             c.name, c.industry, c.region_sido, c.region_sigungu,
             e.address::text as email_address, e.mx_ok, e.email_type
      from leads l
      join companies c on c.id = l.company_id
      left join emails e on e.id = l.email_id
      where (${exported}::text is null
             or (${exported}::text = 'true') = (l.export_status = 'exported'))
      order by l.approval_date desc, l.score desc
      limit ${limit}
    `);
    return { data: rows, meta: { limit } };
  });

  /**
   * export.
   *
   * ❗ 워터마크·횟수 제한·감사 기록은 `export_leads()` 안에 있다. API 가 대신 판단하지
   *    않는다 — 여기서 우회 가능한 게이트는 게이트가 아니다.
   */
  router.get("/api/leads/export", async (ctx: Ctx) => {
    const from = date(ctx.url.searchParams.get("from"), "from");
    const to = date(ctx.url.searchParams.get("to"), "to");
    if (from > to) throw badRequest("from 이 to 보다 늦습니다");

    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ export_leads: unknown }>>`
      select public.export_leads(${from}::date, ${to}::date)
    `);
    return { data: rows.map((r) => r.export_leads), meta: { from, to, count: rows.length } };
  });

  return router;
}
