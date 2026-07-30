import { Industry, type Logger } from "@leadops/core";
import { startRun } from "@leadops/pipeline";
import { badRequest, Router, type Ctx } from "../http";
import type { Session } from "../session";

/**
 * 내부 트리거 — pg_cron → pg_net → 여기 (설계서 7.2 `POST /internal/run`).
 *
 * ❗ **설계서는 이 경로를 워커에 두었다.** 워커에는 HTTP 서버가 없고, `startRun` 은 이미 이
 *    프로세스에 있다(`POST /api/runs`). 서버를 하나 더 띄우면 포트·프로세스 관리가 늘고
 *    같은 코드가 두 곳에 생긴다. 서명 검증은 라우팅 전에 이뤄지므로 인증 모델도 섞이지 않는다.
 *
 * ❗ **실행할지 말지는 DB 가 정한다** (`should_start_scheduled_run`). cron 표현식은 "부를 시각"
 *    만 알고, 평일 판정·중복 방지·용량 차단은 여기서 판정한다. cron 이 주말에 불려도
 *    200 + `skipped` 로 답한다 — 실패가 아니므로 알림을 울릴 이유가 없다.
 */

export interface InternalDeps {
  session: Session;
}

interface TriggerBody {
  industries?: unknown;
  limit?: unknown;
  /** 판정만 하고 실행하지 않는다. 스케줄 점검용. */
  dryRun?: unknown;
}

interface Decision {
  should_run: boolean;
  run_date: string;
  reasons: string[];
  capacity: Record<string, unknown>;
  existing_run_id: string | null;
}

export function internalRoutes(deps: InternalDeps): Router {
  const router = new Router();

  router.post("/internal/run", async (ctx: Ctx) => {
    const body = await ctx.body<TriggerBody>();

    const raw = body.industries;
    const industries =
      raw === undefined || raw === null
        ? Industry.options
        : Array.isArray(raw)
          ? raw.map((value) => {
              const parsed = Industry.safeParse(value);
              if (!parsed.success) throw badRequest(`알 수 없는 업종: ${String(value)}`);
              return parsed.data;
            })
          : (() => {
              throw badRequest("industries 는 배열이어야 합니다");
            })();
    if (industries.length === 0) throw badRequest("industries 가 비어 있습니다");

    const limit = body.limit === undefined ? 500 : Number(body.limit);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 5000) {
      throw badRequest("limit 은 1~5000 사이의 정수여야 합니다");
    }

    // 판정은 서버 권한으로 한다 — 사용자 컨텍스트가 없는 경로다.
    const [decisionRow] = await deps.session.serverWide((sql) => sql<Array<{ d: Decision }>>`
      select public.should_start_scheduled_run() as d
    `);
    const decision = decisionRow!.d;

    if (!decision.should_run) {
      ctx.logger.info("schedule.skipped", { reasons: decision.reasons, runDate: decision.run_date });
      return { data: { started: false, skipped: true, decision } };
    }
    if (body.dryRun === true) {
      return { data: { started: false, dryRun: true, decision, industries, perIndustryLimit: limit } };
    }

    // ❗ `serverWide` 를 쓴다. `startRun` 이 스스로 트랜잭션을 열기 때문에 트랜잭션 안에서
    //    호출하면 postgres.js 가 `sql.begin is not a function` 으로 깨진다.
    const started = await deps.session.serverWide((sql) =>
      startRun(sql, {
        trigger: "cron",
        runDate: decision.run_date,
        industries,
        perIndustryLimit: limit,
        logger: ctx.logger as Logger,
      }),
    );

    // ❗ actor 가 null 인 감사 기록이다 (사람이 아니다). 그래도 남긴다 — 실행이 어디서
    //    왔는지 추적할 수 없으면 원인 분석이 불가능하다.
    await deps.session.serverWide((sql) => sql`
      insert into audit_log (actor, action, entity, entity_id, after)
      values (null, 'run.schedule', 'runs', ${started.runId},
              ${sql.json({ industries, perIndustryLimit: limit, trigger: "cron" })})
    `);

    ctx.logger.info("schedule.started", { runId: started.runId, runDate: decision.run_date });
    return { data: { started: true, ...started, decision } };
  });

  return router;
}
