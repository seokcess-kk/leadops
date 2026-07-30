import { countSkip, emptyResult, type StageContext, type StageHandler, type StageResult } from "./types";

/**
 * 스테이지 8·9 — 경쟁사 선정과 비교 (설계서 5.3 스테이지 9·10 · 부록 A.6).
 *
 * ❗ **경쟁사를 검색 결과로 뽑지 않는다.** 검색으로 뽑으면 이미 검색에 잘 나오는 업체만
 *    경쟁사가 되고, 그러면 모든 대상이 "경쟁사보다 뒤처짐" 으로 보인다. 선택편향이
 *    그대로 허위 취약점이 된다. 대신 **업종·지역·규모 매칭**으로 고른다.
 *
 * ❗ 같은 `group_id`(동일 네트워크·다지점)는 경쟁사가 아니다. 자기 분원을 경쟁사로
 *    삼으면 격차가 항상 0 이 된다.
 *
 * ❗ 유효 경쟁사가 2곳 미만이면 격차 항목을 **`unavailable` 로 두고 재정규화하지 않는다**
 *    (A.6). 결측을 0점으로 바꾸면 우리 수집 실패가 상대의 취약점이 된다.
 */

const BATCH = 200;
const PEERS_PER_COMPANY = 3;

interface Target {
  company_id: string;
  industry: string;
  region_sido: string | null;
  region_sigungu: string | null;
  region_dong: string | null;
  size_tier: string | null;
  group_id: string | null;
}

export const competitorSelectStage: StageHandler = {
  stage: "competitor_select",
  // 순수 DB 매칭이므로 홈페이지 판별을 기다릴 필요가 없다 (설계서 DAG: 4 완료).
  dependsOn: ["exclude_basic"],

  async run(ctx: StageContext): Promise<StageResult> {
    const result = emptyResult();

    // ❗ offset 순회다. "아직 경쟁사가 없는 업체" 를 조건으로 돌면, 후보가 없어 건너뛴
    //    업체가 다음 조회에 다시 잡혀 무한 루프가 된다. 멱등성은 유일키가 보장한다.
    let offset = 0;
    for (;;) {
      const targets = await ctx.sql<Target[]>`
        select c.id as company_id, c.industry, c.region_sido, c.region_sigungu,
               c.region_dong, c.size_tier, c.group_id
        from companies c
        join company_observations o on o.company_id = c.id and o.attempt_id = ${ctx.attemptId}
        where c.excluded_reason is null
        order by c.id
        limit ${BATCH} offset ${offset}
      `;
      if (targets.length === 0) break;
      offset += targets.length;

      for (const target of targets) {
        result.processed++;

        // 유사도: 지역이 가까울수록, 규모가 같을수록 높다.
        // ❗ 검색 순위·트래픽 같은 성과 지표를 쓰지 않는다 — 그것이 선택편향의 입구다.
        const peers = await ctx.sql<Array<{ id: string; name: string; similarity: number; region_sigungu: string | null; size_tier: string | null }>>`
          select p.id, p.name, p.region_sigungu, p.size_tier,
                 (case
                    when p.region_dong is not null and p.region_dong = ${target.region_dong} then 3
                    when p.region_sigungu is not null and p.region_sigungu = ${target.region_sigungu} then 2
                    when p.region_sido is not null and p.region_sido = ${target.region_sido} then 1
                    else 0
                  end)
                 + (case when p.size_tier is not null and p.size_tier = ${target.size_tier} then 2 else 0 end)
                 as similarity
          from companies p
          where p.industry = ${target.industry}
            and p.id <> ${target.company_id}
            and p.excluded_reason is null
            and p.do_not_contact = false
            -- 같은 네트워크·다지점 제외
            and (${target.group_id}::uuid is null or p.group_id is null or p.group_id <> ${target.group_id})
          order by similarity desc, p.id
          limit ${PEERS_PER_COMPANY}
        `;

        if (peers.length === 0) {
          countSkip(result, "no_peer_candidate");
          continue;
        }

        await ctx.sql.begin(async (tx) => {
          for (const [index, peer] of peers.entries()) {
            await tx`
              insert into competitors (
                attempt_id, company_id, competitor_company_id, competitor_name,
                selection_method, similarity, rank, is_valid
              ) values (
                ${ctx.attemptId}, ${target.company_id}, ${peer.id}, ${peer.name},
                'industry_region_size', ${tx.json({
                  score: peer.similarity,
                  regionSigungu: peer.region_sigungu,
                  sizeTier: peer.size_tier,
                })},
                ${index + 1}, false
              )
              on conflict (attempt_id, company_id, rank) do nothing
            `;
          }
        });
        result.passed++;
      }
    }

    result.note = `${result.processed}개 업체에 경쟁사 후보 배정 (업종·지역·규모 매칭)`;
    return result;
  },
};

interface PeerRow {
  competitor_id: string;
  competitor_company_id: string | null;
}

export const competitorAnalyzeStage: StageHandler = {
  stage: "competitor_analyze",
  /**
   * ❗ 설계서 DAG 는 9(선정)만 선행으로 적었지만, 경쟁사 지표는 **채널·검색 관측에서**
   *    나온다. 그 스테이지들이 끝나기 전에 계산하면 전부 결측이 된다.
   */
  dependsOn: ["competitor_select", "channel_analyze", "search_analyze"],

  async run(ctx: StageContext): Promise<StageResult> {
    const result = emptyResult();

    for (;;) {
      const peers = await ctx.sql<PeerRow[]>`
        select k.id as competitor_id, k.competitor_company_id
        from competitors k
        where k.attempt_id = ${ctx.attemptId}
          and not exists (select 1 from competitor_metrics m where m.competitor_id = k.id)
        order by k.id
        limit ${BATCH}
      `;
      if (peers.length === 0) break;

      for (const peer of peers) {
        result.processed++;
        if (!peer.competitor_company_id) {
          await markInvalid(ctx, peer.competitor_id, "no_company_link");
          countSkip(result, "no_company_link");
          continue;
        }

        // 경쟁사 지표는 **가장 최근 관측**에서 가져온다. 같은 attempt 로 제한하면
        // 같은 실행에 함께 잡힌 업체만 경쟁사가 될 수 있어 사실상 항상 결측이 된다.
        const [official] = await ctx.sql<Array<{ official_status: string }>>`
          select wo.official_status::text as official_status
          from website_observations wo
          join websites w on w.id = wo.website_id
          where w.company_id = ${peer.competitor_company_id}
          order by wo.observed_at desc
          limit 1
        `;
        const analyzed = official?.official_status === "confirmed" || official?.official_status === "likely";
        if (!analyzed) {
          // 아직 분석되지 않은 업체다. 0 으로 채우지 않고 무효로 둔다 (A.6).
          await markInvalid(ctx, peer.competitor_id, official ? `official_status=${official.official_status}` : "not_analyzed");
          countSkip(result, "peer_not_analyzed");
          continue;
        }

        const [channels] = await ctx.sql<Array<{ types: string; posts60: string; posts120: string }>>`
          select count(distinct ch.type)::text as types,
                 coalesce(sum(co.posts_60d), 0)::text as posts60,
                 coalesce(sum(co.posts_120d), 0)::text as posts120
          from channels ch
          left join lateral (
            select posts_60d, posts_120d from channel_observations x
            where x.channel_id = ch.id and x.analyzable
            order by x.observed_at desc limit 1
          ) co on true
          where ch.company_id = ${peer.competitor_company_id}
        `;

        const [search] = await ctx.sql<Array<{ ors: string | null; official: string; related: string; nonbrand: string }>>`
          select percentile_cont(0.5) within group (order by sa.ors)::text as ors,
                 coalesce(sum(sa.official_count), 0)::text as official,
                 coalesce(sum(sa.related_count), 0)::text as related,
                 coalesce(sum(sa.related_count) filter (where sa.keyword_kind = 'nonbrand'), 0)::text as nonbrand
          from search_aggregates sa
          where sa.company_id = ${peer.competitor_company_id} and sa.denominator > 0
        `;

        const officialAssets = Number(search?.official ?? 0);
        const related = Number(search?.related ?? 0);

        await ctx.sql`
          insert into competitor_metrics (
            competitor_id, ors, official_assets, thirdparty_assets, diversity,
            recency_60d, nonbrand_exposure, channel_activity, raw
          ) values (
            ${peer.competitor_id}, ${search?.ors ?? null}, ${officialAssets},
            ${Math.max(related - officialAssets, 0)}, ${Number(channels?.types ?? 0)},
            ${Number(channels?.posts60 ?? 0)}, ${Number(search?.nonbrand ?? 0)},
            ${Number(channels?.posts120 ?? 0)},
            ${ctx.sql.json({ source: "latest_observations", officialStatus: official.official_status })}
          )
          on conflict (competitor_id) do update set
            ors = excluded.ors,
            official_assets = excluded.official_assets,
            thirdparty_assets = excluded.thirdparty_assets,
            diversity = excluded.diversity,
            recency_60d = excluded.recency_60d,
            nonbrand_exposure = excluded.nonbrand_exposure,
            channel_activity = excluded.channel_activity,
            raw = excluded.raw
        `;
        await ctx.sql`update competitors set is_valid = true where id = ${peer.competitor_id}`;
        result.passed++;
      }
    }

    const [summary] = await ctx.sql<Array<{ companies: string; ready: string }>>`
      select count(distinct company_id)::text as companies,
             count(distinct company_id) filter (where valid_count >= 2)::text as ready
      from (
        select company_id, count(*) filter (where is_valid) as valid_count
        from competitors where attempt_id = ${ctx.attemptId}
        group by company_id
      ) t
    `;
    const companies = Number(summary?.companies ?? 0);
    const ready = Number(summary?.ready ?? 0);
    if (companies - ready > 0) result.skipped["gap_unavailable"] = companies - ready;

    result.note =
      `경쟁사 ${result.processed}건 분석 · 업체 ${companies}곳 중 ${ready}곳이 격차 산출 가능(유효 2곳 이상)`;

    if (companies > 0 && ready / companies < 0.5) {
      // 초기 실행에서는 정상이다 — 비교 대상이 아직 분석되지 않았을 뿐이다.
      ctx.logger.warn("competitor.cold_start", {
        companies,
        ready,
        note:
          "유효 경쟁사가 부족한 업체가 절반을 넘습니다. 모집단을 아직 충분히 훑지 않은 " +
          "초기 실행에서는 정상입니다. 누적 실행이 쌓이면 해소됩니다.",
      });
    }
    return result;
  },
};

async function markInvalid(ctx: StageContext, competitorId: string, reason: string): Promise<void> {
  await ctx.sql`
    insert into competitor_metrics (competitor_id, raw)
    values (${competitorId}, ${ctx.sql.json({ invalid: reason })})
    on conflict (competitor_id) do update set raw = excluded.raw
  `;
  await ctx.sql`update competitors set is_valid = false where id = ${competitorId}`;
}
