import { collectionSettingsFrom, scoringSettingsFrom, targetSettingsFrom } from "@leadops/pipeline";
import { badRequest, forbidden, Router, type Ctx } from "../http";
import type { Session } from "../session";

/**
 * 운영 설정과 비용 (설계서 7.2).
 *
 * ❗ 설정 키는 화이트리스트로 막는다. 오타 난 키를 그대로 받으면 아무 효과 없는 행이 쌓이고,
 *    운영자는 값을 바꿨다고 믿는다. 없는 키는 400 으로 거절한다.
 *
 * ❗ 응답에는 **실제로 적용된 값**(effective)을 함께 돌려준다. 파서는 형식이 어긋난 값을
 *    조용히 기본값으로 되돌리므로, 저장된 JSON 만 보여 주면 반영되지 않은 설정을
 *    반영된 것으로 오해한다.
 */

export interface SettingsDeps {
  session: Session;
}

const KEYS = new Set([
  "collection", "cost", "export", "privacy", "quota", "review", "schedule", "scoring", "targets",
]);

type Row = Record<string, unknown>;

function effectiveOf(rows: Array<{ key: string; value: unknown }>): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (const row of rows) bag[row.key] = row.value;
  return {
    scoring: scoringSettingsFrom(bag),
    targets: targetSettingsFrom(bag),
    collection: collectionSettingsFrom(bag),
  };
}

export function settingsRoutes(deps: SettingsDeps): Router {
  const router = new Router();

  router.get("/api/settings", async (ctx: Ctx) => {
    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{
      key: string; value: unknown; updated_at: string; updated_by: string | null;
    }>>`select key, value, updated_at, updated_by from settings order by key`);
    return { data: { rows, effective: effectiveOf(rows) } };
  });

  router.put("/api/settings/:key", async (ctx: Ctx) => {
    if (!(await deps.session.isAdmin(ctx.userId))) throw forbidden("admin 권한이 필요합니다");

    const key = ctx.params["key"]!;
    if (!KEYS.has(key)) throw badRequest(`알 수 없는 설정 키: ${key}`);

    const body = await ctx.body<{ value?: unknown }>();
    const value = body.value;
    // ❗ 스칼라·배열을 넣으면 파서가 전부 기본값으로 되돌린다 — 설정이 통째로 사라지는 것과 같다.
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw badRequest("value 는 객체여야 합니다");
    }

    return deps.session.asUser(ctx.userId, async (tx) => {
      // 본문은 JSON.parse 를 통과한 값이므로 JSON 으로 직렬화 가능하다. 타입만 좁혀 준다.
      const json = value as Parameters<typeof tx.json>[0];
      await tx`select public.update_setting(${key}, ${tx.json(json)})`;
      const rows = await tx<Array<{ key: string; value: unknown; updated_at: string }>>`
        select key, value, updated_at from settings order by key
      `;
      const saved = rows.find((row) => row.key === key)!;
      return { data: { row: saved, effective: effectiveOf(rows) } };
    });
  });

  /**
   * 비용 현황.
   *
   * 일 상한(`cost.daily_cap_krw`)은 예약 시점에 워커가 강제한다. 여기서는 **왜 멈췄는지**
   * 보여 준다 — 어떤 제공자가 예산을 먹었는지 알 수 없으면 상한을 조정할 근거가 없다.
   *
   * ❗ admin 전용이다. `cost_ledger` 의 RLS 가 이미 admin 만 읽게 되어 있어서, 검수자에게
   *    열어 주면 조용히 **빈 목록**이 나간다 — "비용이 0원" 으로 보이는 것이 더 나쁘다.
   */
  router.get("/api/costs", async (ctx: Ctx) => {
    if (!(await deps.session.isAdmin(ctx.userId))) throw forbidden("비용 조회는 admin 전용입니다");
    return deps.session.asUser(ctx.userId, async (tx) => {
      const [daily, providers, caps, today] = await Promise.all([
        tx<Row[]>`
          select (created_at at time zone 'Asia/Seoul')::date as day,
                 sum(krw)::float8 as krw
          from cost_ledger
          where created_at >= now() - interval '30 days'
          group by 1 order by 1 desc
        `,
        tx<Row[]>`
          select provider, unit, sum(qty)::float8 as qty, sum(krw)::float8 as krw, count(*)::int as entries
          from cost_ledger
          where created_at >= now() - interval '30 days'
          group by provider, unit order by krw desc
        `,
        tx<Array<{ daily_cap_krw: number | null; llm_monthly_cap_krw: number | null }>>`
          select (value->>'daily_cap_krw')::float8 as daily_cap_krw,
                 (value->>'llm_monthly_cap_krw')::float8 as llm_monthly_cap_krw
          from settings where key = 'cost'
        `,
        tx<Array<{ krw: number }>>`
          select coalesce(sum(krw), 0)::float8 as krw from cost_ledger
          where (created_at at time zone 'Asia/Seoul')::date
              = (now() at time zone 'Asia/Seoul')::date
        `,
      ]);
      return {
        data: {
          daily,
          providers,
          caps: caps[0] ?? { daily_cap_krw: null, llm_monthly_cap_krw: null },
          todayKrw: today[0]?.krw ?? 0,
        },
      };
    });
  });

  return router;
}
