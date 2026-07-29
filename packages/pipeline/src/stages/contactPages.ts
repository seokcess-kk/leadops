import { emptyResult, type StageContext, type StageHandler, type StageResult } from "./types";

/**
 * 같은 본문이 이만큼 많은 사이트에서 나오면 그건 그 업체의 홈페이지가 아니다.
 *
 * ❗ 이 방어가 필요한 이유는 **DNS NXDOMAIN 하이재킹** 때문이다. 국내 ISP 상당수가
 *    존재하지 않는 도메인을 자사 안내 페이지 IP 로 응답한다(실측: KT 는 모든 미등록
 *    도메인을 `121.78.127.249` 로 돌린다). 그러면 이미 폐업해 도메인이 사라진 업체의
 *    홈페이지도 "살아 있고 200 을 주는 사이트" 로 보인다.
 *
 *    도메인은 전부 다르므로 `SHARED_DOMAIN_LIMIT` 로는 걸리지 않는다. 잡히는 지점은
 *    **본문이 똑같다**는 것뿐이다. 그래서 실행 단위로 content_hash 를 모아 본다.
 *
 *    2곳이 아니라 3곳부터인 이유: 한 업체가 `example.co.kr` 과 `example.kr` 로 같은
 *    사이트를 서비스하는 것은 정상이다.
 */
const SHARED_CONTENT_LIMIT = 3;

/**
 * 스테이지 5 — 연락처 페이지 게이트·집계 (설계서 5.3 스테이지 6).
 *
 * 후보 URL 자체는 `homepage_detect` 가 같은 HTML 에서 이미 뽑아 뒀다(그 파일의 주석 참고).
 * 이 스테이지가 맡는 일은 두 가지다.
 *
 *  1. **게이트 강제** — 공식으로 인정되지 않은(`confirmed`·`likely` 가 아닌) 사이트의
 *     후보를 지운다. 앞 스테이지가 잘 했으리라 믿는 대신 불변식을 여기서 다시 세운다.
 *     규칙을 바꿔 재실행했을 때 이전 판정으로 남은 후보가 살아 있으면 안 되기 때문이다.
 *  2. **커버리지 집계** — 설계서 M3(연락처 페이지 후보 적중률 ≥ 50%)를 측정할 분모·분자를
 *     남긴다. 후보가 하나도 없는 사이트는 검수자가 이메일을 넣을 방법이 없으므로
 *     리드가 될 수 없다. 그 수를 조용히 넘기지 않는다.
 *
 * ❗ 이 스테이지도 후보 페이지의 본문을 가져오지 않는다. 네트워크 요청이 아예 없다.
 */
export const contactPagesStage: StageHandler = {
  stage: "contact_pages",
  dependsOn: ["homepage_detect"],

  async run(ctx: StageContext): Promise<StageResult> {
    const result = emptyResult();

    // ── 0. 같은 본문을 주는 사이트들을 강등 (DNS 하이재킹·주차 페이지) ──
    // 실행 안의 모든 홈페이지를 다 받아 본 뒤에야 알 수 있으므로 여기서 한다.
    const demoted = await ctx.sql<Array<{ website_id: string }>>`
      with dup as (
        select content_hash, count(*) as n
        from website_observations
        where attempt_id = ${ctx.attemptId}
          and content_hash is not null
          and official_status <> 'not_official'
        group by content_hash
        having count(*) >= ${SHARED_CONTENT_LIMIT}
      )
      update website_observations wo
      set official_status = 'not_official',
          signals = wo.signals
            || jsonb_build_object('disqualified', 'shared_content', 'sharedContentCount', dup.n)
      from dup
      where wo.attempt_id = ${ctx.attemptId}
        and wo.content_hash = dup.content_hash
        and wo.official_status <> 'not_official'
      returning wo.website_id
    `;
    if (demoted.length > 0) {
      result.skipped["shared_content"] = demoted.length;
      ctx.logger.warn("contact_pages.shared_content", {
        websites: demoted.length,
        note: "여러 도메인이 같은 본문을 반환했습니다. DNS 하이재킹이나 주차 페이지일 수 있습니다.",
      });
    }

    // ── 1. 게이트 ──
    const removed = await ctx.sql<Array<{ id: string }>>`
      delete from contact_pages cp
      using website_observations wo
      where cp.attempt_id = ${ctx.attemptId}
        and wo.website_id = cp.website_id
        and wo.attempt_id = cp.attempt_id
        and wo.official_status not in ('confirmed', 'likely')
      returning cp.id
    `;
    if (removed.length > 0) result.skipped["revoked_not_official"] = removed.length;

    // 관측이 아예 없는 사이트의 후보도 남겨 두지 않는다 (재실행 잔재).
    const orphans = await ctx.sql<Array<{ id: string }>>`
      delete from contact_pages cp
      where cp.attempt_id = ${ctx.attemptId}
        and not exists (
          select 1 from website_observations wo
          where wo.website_id = cp.website_id and wo.attempt_id = cp.attempt_id
        )
      returning cp.id
    `;
    if (orphans.length > 0) result.skipped["orphan_candidate"] = orphans.length;

    // ── 2. 집계 ──
    const [summary] = await ctx.sql<
      Array<{ official: string; with_pages: string; form_only: string; candidates: string }>
    >`
      select
        count(*) filter (where wo.official_status in ('confirmed', 'likely'))::text as official,
        count(*) filter (where wo.official_status in ('confirmed', 'likely') and c.n > 0)::text as with_pages,
        count(*) filter (
          where wo.official_status in ('confirmed', 'likely') and c.n = 0 and wo.has_contact_form_only
        )::text as form_only,
        coalesce(sum(c.n) filter (where wo.official_status in ('confirmed', 'likely')), 0)::text as candidates
      from website_observations wo
      cross join lateral (
        select count(*) as n from contact_pages cp
        where cp.website_id = wo.website_id and cp.attempt_id = wo.attempt_id
      ) c
      where wo.attempt_id = ${ctx.attemptId}
    `;

    const official = Number(summary?.official ?? 0);
    const withPages = Number(summary?.with_pages ?? 0);
    const formOnly = Number(summary?.form_only ?? 0);

    result.processed = official;
    result.passed = withPages;
    if (official - withPages > 0) result.skipped["no_contact_page"] = official - withPages;
    // 문의 폼만 있는 업체는 설계서상 제외 대상이다. 별도로 세어 검수 화면이 구분할 수 있게 한다.
    if (formOnly > 0) result.skipped["contact_form_only"] = formOnly;

    const coverage = official > 0 ? Math.round((withPages / official) * 100) : 0;
    result.note =
      `공식 ${official}개 중 ${withPages}개에서 연락처 페이지 후보 확보 (커버리지 ${coverage}%, ` +
      `후보 총 ${summary?.candidates ?? "0"}건)`;

    if (official > 0 && coverage < 50) {
      // 설계서 M3 하한. 막지는 않되 반드시 눈에 띄게 남긴다.
      ctx.logger.warn("contact_pages.low_coverage", {
        coverage,
        official,
        withPages,
        note: "설계서 M3 기준(≥50%) 미달. 탐지 규칙 보강이 필요합니다.",
      });
    }

    return result;
  },
};
