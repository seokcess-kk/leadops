import { Industry, type Logger } from "@leadops/core";
import { startRun } from "@leadops/pipeline";
import { badRequest, forbidden, pageLimit, Router, type Ctx } from "../http";
import type { Session } from "../session";

type Row = Record<string, unknown>;

/**
 * 실행 이력·수동 실행·재시도·취소 (설계서 7.2).
 *
 * ❗ 재시도·취소는 RPC 가 규칙을 강제한다 — 끝난 실행은 취소할 수 없고, 재시도는 **새
 *    attempt** 를 만들고 이전 점수를 무효화한다(R2-21). API 가 대신 판단하지 않는다.
 */

export interface RunDeps {
  session: Session;
}

interface CreateRunBody {
  industries?: unknown;
  limit?: unknown;
  dryRun?: unknown;
}

interface RetryBody {
  fromStage?: unknown;
}

const STAGES = [
  "collect", "normalize", "exclude_basic", "homepage_detect", "contact_pages",
  "channel_analyze", "search_analyze", "competitor_select", "competitor_analyze",
  "score", "recommend", "shortlist",
];

async function assertAdmin(deps: RunDeps, ctx: Ctx): Promise<void> {
  if (!(await deps.session.isAdmin(ctx.userId))) throw forbidden("admin 권한이 필요합니다");
}

export function runRoutes(deps: RunDeps): Router {
  const router = new Router();

  router.get("/api/runs", async (ctx: Ctx) => {
    const limit = pageLimit(ctx.url);
    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Row[]>`
      select r.id, r.run_date, r.trigger, r.status, r.started_at, r.finished_at, r.counts,
             (select max(attempt_no) from run_attempts a where a.run_id = r.id) as attempts,
             (select coalesce(sum(cl.krw), 0)::float8 from cost_ledger cl where cl.run_id = r.id) as cost_krw
      from runs r
      order by r.run_date desc, r.started_at desc nulls last
      limit ${limit}
    `);
    return { data: rows, meta: { limit } };
  });

  router.get("/api/runs/:id", async (ctx: Ctx) => {
    const id = ctx.params["id"]!;
    // ❗ `jobs` 의 RLS 는 admin 만 읽게 되어 있다. 그대로 질의하면 검수자에게는 조용히 빈
    //    배열이 나가고, "실패한 잡이 없다" 로 읽힌다. 볼 수 없다는 사실을 함께 알려 준다.
    const canSeeJobs = await deps.session.isAdmin(ctx.userId);
    return deps.session.asUser(ctx.userId, async (tx) => {
      const [run] = await tx<Row[]>`
        select id, run_date, trigger, status, started_at, finished_at, counts, settings_snapshot
        from runs where id = ${id}
      `;
      if (!run) throw badRequest("실행을 찾을 수 없습니다");

      const [stages, failed, costs] = await Promise.all([
        tx<Row[]>`
          select a.attempt_no, s.stage, s.status, s.total, s.done, s.failed, s.started_at, s.finished_at
          from run_stages s
          join run_attempts a on a.id = s.attempt_id
          where a.run_id = ${id}
          order by a.attempt_no desc, s.stage
        `,
        canSeeJobs
          ? tx<Row[]>`
              select j.id::text as id, j.stage, j.status, j.attempts, j.max_attempts, j.last_error
              from jobs j
              join run_attempts a on a.id = j.attempt_id
              where a.run_id = ${id} and j.status in ('dead', 'failed')
              order by j.id
              limit 100
            `
          : Promise.resolve([] as Row[]),
        tx<Row[]>`
          select provider, unit, sum(qty)::float8 as qty, sum(krw)::float8 as krw
          from cost_ledger where run_id = ${id}
          group by provider, unit order by provider
        `,
      ]);
      return {
        data: { run, stages, failedJobs: failed, costs },
        meta: { failedJobsVisible: canSeeJobs },
      };
    });
  });

  /**
   * 수동 실행.
   *
   * ❗ RPC 대신 `startRun`(파이프라인 코드)을 쓴다. 12단계 DAG 를 SQL 에 다시 적으면
   *    스테이지를 추가할 때마다 두 곳이 갈라진다. 대신 **admin 검사는 DB 에서** 한다
   *    (`is_admin()`), 그래서 클라이언트가 토큰 클레임으로 관리자를 주장할 수 없다.
   */
  router.post("/api/runs", async (ctx: Ctx) => {
    await assertAdmin(deps, ctx);
    const body = await ctx.body<CreateRunBody>();

    const raw = body.industries;
    if (!Array.isArray(raw) || raw.length === 0) throw badRequest("industries 가 필요합니다");
    const industries = raw.map((value) => {
      const parsed = Industry.safeParse(value);
      if (!parsed.success) throw badRequest(`알 수 없는 업종: ${String(value)}`);
      return parsed.data;
    });

    const limit = typeof body.limit === "number" ? body.limit : 500;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 5000) {
      throw badRequest("limit 은 1~5000 사이의 정수여야 합니다");
    }
    if (body.dryRun === true) {
      // 실제로 만들지 않고 무엇이 만들어질지만 알려 준다.
      return { data: { dryRun: true, industries, perIndustryLimit: limit, stages: STAGES } };
    }

    // ❗ `serverWide` 를 쓴다. `startRun` 은 스스로 트랜잭션을 열기 때문에 트랜잭션 안에서
    //    호출하면 postgres.js 가 `sql.begin is not a function` 으로 깨진다.
    const started = await deps.session.serverWide((sql) =>
      startRun(sql, {
        trigger: "manual",
        industries,
        perIndustryLimit: limit,
        logger: ctx.logger as Logger,
      }),
    );
    // 수동 실행도 감사 대상이다. startRun 은 로그만 남기므로 여기서 기록한다.
    await deps.session.privileged(ctx.userId, (tx) => tx`
      insert into audit_log (actor, action, entity, entity_id, after)
      values (${ctx.userId}::uuid, 'run.create', 'runs', ${started.runId},
              ${tx.json({ industries, perIndustryLimit: limit, trigger: "manual" })})
    `);
    return { data: started };
  });

  router.post("/api/runs/:id/retry", async (ctx: Ctx) => {
    await assertAdmin(deps, ctx);
    const body = await ctx.body<RetryBody>();
    const fromStage = typeof body.fromStage === "string" ? body.fromStage : "";
    if (!STAGES.includes(fromStage)) {
      throw badRequest(`fromStage 는 ${STAGES.join(", ")} 중 하나여야 합니다`);
    }
    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ retry_run: unknown }>>`
      select public.retry_run(${ctx.params["id"]!}, ${fromStage})
    `);
    return { data: rows[0]!.retry_run };
  });

  router.post("/api/runs/:id/cancel", async (ctx: Ctx) => {
    await assertAdmin(deps, ctx);
    const body = await ctx.body<{ reason?: unknown }>();
    const reason = typeof body.reason === "string" ? body.reason : null;
    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ cancel_run: unknown }>>`
      select public.cancel_run(${ctx.params["id"]!}, ${reason})
    `);
    return { data: rows[0]!.cancel_run };
  });

  return router;
}
