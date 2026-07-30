import { industryQuota, targetSettingsFrom } from "@leadops/pipeline";
import { badRequest, forbidden, pageLimit, Router, type Ctx } from "../http";
import type { Session } from "../session";

/**
 * 업종·키워드 (설계서 7.2).
 *
 * ❗ 키워드는 **승인 전까지 검색에 쓰이지 않는다.** LLM 초안이 그대로 외부 API 호출로
 *    나가면 비용과 오탐을 통제할 수 없다. 그래서 승인 화면이 필요하다.
 */

export interface IndustryDeps {
  session: Session;
}

type Row = Record<string, unknown>;

export function industryRoutes(deps: IndustryDeps): Router {
  const router = new Router();

  router.get("/api/industries", async (ctx: Ctx) => {
    return deps.session.asUser(ctx.userId, async (tx) => {
      const [companies, keywords, settings, approvals] = await Promise.all([
        tx<Row[]>`
          select c.industry::text as industry,
                 count(*)::int as companies,
                 count(*) filter (where c.excluded_reason is null and c.status = 'active')::int as active,
                 -- 홈페이지 '있음' 은 URL 존재가 아니라 **공식 판정**이다. 대행사 페이지·
                 -- 포털 지점 페이지를 홈페이지로 세면 약점 판단이 뒤집힌다.
                 count(*) filter (where exists (
                   select 1 from websites w
                   join website_observations o on o.website_id = w.id
                   where w.company_id = c.id and o.official_status in ('confirmed', 'likely')
                 ))::int as with_homepage
          from companies c group by 1 order by 1
        `,
        tx<Row[]>`
          select c.industry::text as industry,
                 count(*)::int as keywords,
                 count(*) filter (where k.approved)::int as approved,
                 count(*) filter (where k.source = 'llm' and not k.approved)::int as llm_pending
          from company_keywords k join companies c on c.id = k.company_id
          group by 1 order by 1
        `,
        tx<Array<{ key: string; value: unknown }>>`select key, value from settings`,
        tx<Row[]>`
          select approved_industry::text as industry, count(*)::int as leads
          from leads group by 1
        `,
      ]);

      const targets = targetSettingsFrom(Object.fromEntries(settings.map((s) => [s.key, s.value])));
      const quota = industryQuota(targets.finalMax, targets.industryShareMax);
      const byIndustry = new Map<string, Row>();
      const slot = (industry: string): Row => {
        let row = byIndustry.get(industry);
        if (!row) {
          row = { industry, companies: 0, active: 0, with_homepage: 0, keywords: 0, approved: 0, llm_pending: 0, leads: 0, quota };
          byIndustry.set(industry, row);
        }
        return row;
      };
      for (const row of companies) Object.assign(slot(String(row["industry"])), row);
      for (const row of keywords) Object.assign(slot(String(row["industry"])), row);
      for (const row of approvals) Object.assign(slot(String(row["industry"])), row);

      return { data: [...byIndustry.values()], meta: { finalMax: targets.finalMax, industryShareMax: targets.industryShareMax, quota } };
    });
  });

  router.get("/api/keywords", async (ctx: Ctx) => {
    const limit = pageLimit(ctx.url);
    const industry = ctx.url.searchParams.get("industry");
    const pendingOnly = ctx.url.searchParams.get("pending") === "1";

    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Row[]>`
      select k.id, k.keyword, k.kind, k.source, k.approved, k.priority,
             c.id as company_id, c.name as company_name, c.industry::text as industry
      from company_keywords k
      join companies c on c.id = k.company_id
      where (${industry}::text is null or c.industry::text = ${industry})
        and (${pendingOnly}::boolean is not true or k.approved = false)
      order by k.approved, c.industry, k.priority desc, k.keyword
      limit ${limit}
    `);
    return { data: rows, meta: { limit } };
  });

  router.post("/api/keywords/:id/approve", async (ctx: Ctx) => {
    if (!(await deps.session.isAdmin(ctx.userId))) throw forbidden("admin 권한이 필요합니다");
    const body = await ctx.body<{ approved?: unknown }>();
    if (typeof body.approved !== "boolean") throw badRequest("approved 는 boolean 이어야 합니다");

    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ approve_keyword: unknown }>>`
      select public.approve_keyword(${ctx.params["id"]!}, ${body.approved as boolean})
    `);
    return { data: rows[0]!.approve_keyword };
  });

  return router;
}
