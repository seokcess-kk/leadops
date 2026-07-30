import { verifyEmailAddress, type MxResolver } from "@leadops/http";
import { badRequest, pageLimit, Router, type Ctx } from "../http";

type Row = Record<string, unknown>;
import type { Session } from "../session";

/**
 * 검수 API (설계서 7.2 · 8.2).
 *
 * 상태를 바꾸는 것은 전부 RPC 다. API 는 **입력을 옮기고 결과를 옮길 뿐**이고, 상한·쿼터·
 * 게이트·nonce·rate limit 은 DB 안에서 강제된다. 그래야 API 를 우회해도 규칙이 유지된다.
 */

export interface ReviewDeps {
  session: Session;
  resolver?: MxResolver | undefined;
}

interface ContactEmailBody {
  address?: unknown;
  emailType?: unknown;
  contactPageId?: unknown;
  nonce?: unknown;
}

interface DecisionBody {
  status?: unknown;
  reason?: unknown;
  emailId?: unknown;
}

interface BulkBody {
  itemIds?: unknown;
  reason?: unknown;
}

/**
 * `email_type` 열거형과 **정확히 일치해야 한다** (마이그레이션 0001).
 *
 * 어긋나면 API 가 통과시킨 값이 DB 캐스팅에서 터져 400 이 아니라 500 이 된다 —
 * 사용자는 무엇이 잘못됐는지 알 수 없다.
 */
const EMAIL_TYPES = [
  "representative",
  "inquiry",
  "partnership",
  "marketing",
  "business_info",
  "staff",
  "unknown",
] as const;

const str = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw badRequest(`${field} 가 필요합니다`);
  return value.trim();
};

export function reviewRoutes(deps: ReviewDeps): Router {
  const router = new Router();

  // ── 목록 ──
  router.get("/api/review", async (ctx: Ctx) => {
    const limit = pageLimit(ctx.url);
    const status = ctx.url.searchParams.get("status") ?? "pending";
    if (!["pending", "approved", "rejected"].includes(status)) {
      throw badRequest("status 는 pending·approved·rejected 중 하나여야 합니다");
    }

    const rows = await deps.session.asUser(ctx.userId, (tx) => tx<Row[]>`
      select ri.id, ri.rank, ri.status, c.id as company_id, c.name, c.industry,
             c.region_sido, c.region_sigungu,
             s.axis_problem::float8 as axis_problem, s.axis_propensity::float8 as axis_propensity,
             s.axis_confidence::float8 as axis_confidence, s.total::float8 as total,
             s.weaknesses, (s.breakdown -> 'normalized')::float8 as normalized,
             r.primary_service, r.secondary_services,
             e.id as email_id, e.address::text as email_address, e.mx_ok
      from review_items ri
      join scores s on s.id = ri.score_id
      join companies c on c.id = ri.company_id
      left join recommendations r on r.score_id = s.id
      -- ❗ lateral + limit 1 이어야 한다. 그냥 join 하면 같은 업체에 수동 입력 이메일이
      --    여러 건일 때 **검수 항목이 중복 행으로 나온다** (재입력·유형 변경으로 실제로 생긴다).
      left join lateral (
        select e.id, e.address, e.mx_ok
        from emails e
        where e.company_id = c.id and e.acquisition_method = 'manual_entry'
        order by e.entered_at desc nulls last
        limit 1
      ) e on true
      where ri.status = ${status}::review_status
      order by ri.rank
      limit ${limit}
    `);
    return { data: rows, meta: { limit, status } };
  });

  // ── 상세 (진입 시 nonce 발급) ──
  router.get("/api/review/:id", async (ctx: Ctx) => {
    const id = ctx.params["id"]!;
    return deps.session.asUser(ctx.userId, async (tx) => {
      const [item] = await tx<Row[]>`
        select ri.id, ri.rank, ri.status, ri.note,
               c.id as company_id, c.name, c.industry, c.region_sido, c.region_sigungu,
               c.phone, c.size_tier, c.do_not_contact,
               s.id as score_id, s.axis_problem::float8 as axis_problem,
               s.axis_propensity::float8 as axis_propensity,
               s.axis_confidence::float8 as axis_confidence, s.total::float8 as total,
               s.breakdown, s.weaknesses, s.competitor_gap_available, s.ors_scored,
               s.gate_passed, s.rule_version,
               r.primary_service, r.secondary_services, r.rationale
        from review_items ri
        join scores s on s.id = ri.score_id
        join companies c on c.id = ri.company_id
        left join recommendations r on r.score_id = s.id
        where ri.id = ${id}
      `;
      if (!item) throw badRequest("검수 항목을 찾을 수 없습니다");

      const companyId = item["company_id"] as string;
      const [websites, contactPages, channels, ors, competitors, email] = await Promise.all([
        tx<Row[]>`
          select w.canonical_url, w.domain, wo.official_status, wo.official_score::float8 as official_score,
                 wo.signals, wo.has_contact_form_only
          from websites w
          join website_observations wo on wo.website_id = w.id
          where w.company_id = ${companyId}
          order by wo.observed_at desc limit 3
        `,
        tx<Row[]>`
          select cp.id, cp.url, cp.page_kind, cp.link_text, cp.confidence::float8 as confidence
          from contact_pages cp
          join websites w on w.id = cp.website_id
          where w.company_id = ${companyId}
          order by cp.confidence desc nulls last
        `,
        tx<Row[]>`
          select ch.type, ch.url, co.is_active, co.last_post_at, co.posts_60d, co.posts_120d,
                 co.cadence_days::float8 as cadence_days, co.content_mix, co.analyzable,
                 co.unavailable_reason, co.feed_saturated
          from channels ch
          left join channel_observations co on co.channel_id = ch.id
          where ch.company_id = ${companyId}
          order by ch.type
        `,
        tx<Row[]>`
          select keyword, keyword_kind, provider, total_returned, denominator,
                 related_count, official_count, ors::float8 as ors, recency_dist
          from search_aggregates where company_id = ${companyId}
          order by keyword, provider
        `,
        tx<Row[]>`
          select k.competitor_name, k.rank, k.is_valid, k.similarity,
                 m.ors::float8 as ors, m.recency_60d, m.diversity,
                 m.channel_activity::float8 as channel_activity
          from competitors k
          left join competitor_metrics m on m.competitor_id = k.id
          where k.company_id = ${companyId}
          order by k.rank
        `,
        tx<Row[]>`
          select id, address::text as address, email_type, syntax_ok, dns_ok, mx_ok, mx_hosts,
                 verified_at, is_free_mail, domain_match
          from emails where company_id = ${companyId} and acquisition_method = 'manual_entry'
          order by entered_at desc limit 1
        `,
      ]);

      // 검수 화면을 실제로 연 세션임을 증명할 1회용 nonce.
      // 이메일 입력 RPC 가 이것을 요구한다 — 화면 없이 대량 입력하는 경로를 막는다.
      const nonce =
        item["status"] === "pending"
          ? ((await tx<Array<{ issue_review_nonce: string }>>`
              select public.issue_review_nonce(${id})
            `)[0]?.issue_review_nonce ?? null)
          : null;

      return {
        data: {
          item,
          websites,
          contactPages,
          channels,
          ors,
          competitors,
          email: email[0] ?? null,
          nonce,
        },
      };
    });
  });

  // ── 연락처 수동 입력 → 문법·DNS·MX ──
  router.post("/api/review/:id/contact-email", async (ctx: Ctx) => {
    const id = ctx.params["id"]!;
    const body = await ctx.body<ContactEmailBody>();
    const address = str(body.address, "address");
    const emailType = str(body.emailType, "emailType");
    const contactPageId = str(body.contactPageId, "contactPageId");
    const nonce = str(body.nonce, "nonce");
    if (!(EMAIL_TYPES as readonly string[]).includes(emailType)) {
      throw badRequest(`emailType 은 ${EMAIL_TYPES.join(", ")} 중 하나여야 합니다`);
    }

    // 1) 문법은 DB 에 넣기 전에 본다. 같은 규칙이지만 여기서 걸러야 사유가 분명하다.
    const verification = await verifyEmailAddress(address, deps.resolver);
    if (!verification.syntaxOk) {
      throw badRequest("이메일 형식이 올바르지 않습니다", { reason: verification.reason });
    }

    // 2) 사용자 컨텍스트로 저장한다 — nonce·rate limit·페이지 소속 검사가 DB 에서 일어난다.
    const userId = ctx.userId;
    const [entered] = await deps.session.asUser(userId, (tx) => tx<Array<{ enter_contact_email: { email_id: string } }>>`
      select public.enter_contact_email(
        ${id}, ${address}, ${emailType}::email_type, ${contactPageId}, ${nonce})
    `);
    const emailId = entered!.enter_contact_email.email_id;

    // 3) DNS·MX 결과는 **서버 권한으로만** 기록한다.
    //    이 호출을 사용자 컨텍스트로 하면 검수자가 직접 불러 mx_ok 를 참으로 만들 수 있다.
    await deps.session.privileged(userId, (tx) => tx`
      select public.verify_contact_email(
        ${emailId}, ${verification.dnsOk}, ${verification.mxOk},
        ${verification.mxHosts as unknown as string[]}, ${verification.confidence})
    `);

    return {
      data: {
        emailId,
        syntaxOk: true,
        dnsOk: verification.dnsOk,
        mxOk: verification.mxOk,
        mxHosts: verification.mxHosts,
        implicitMx: verification.implicitMx,
        ...(verification.reason === undefined ? {} : { reason: verification.reason }),
      },
    };
  });

  // ── 승인·제외 ──
  router.post("/api/review/:id/decision", async (ctx: Ctx) => {
    const id = ctx.params["id"]!;
    const body = await ctx.body<DecisionBody>();
    const status = str(body.status, "status");
    if (status !== "approved" && status !== "rejected") {
      throw badRequest("status 는 approved 또는 rejected 여야 합니다");
    }
    const reason = typeof body.reason === "string" ? body.reason : null;
    const emailId = typeof body.emailId === "string" ? body.emailId : null;

    if (status === "approved" && !emailId) {
      // DB 도 막지만, 여기서 걸러야 검수자가 이유를 안다.
      throw badRequest("승인에는 MX 검증을 통과한 emailId 가 필요합니다");
    }
    if (status === "rejected" && !reason) throw badRequest("제외에는 사유가 필요합니다");

    const [result] = await deps.session.asUser(ctx.userId, (tx) => tx<Array<{ decide_review_item: unknown }>>`
      select public.decide_review_item(${id}, ${status}::review_status, ${reason}, ${emailId})
    `);
    return { data: result!.decide_review_item };
  });

  // ── 일괄 처리 — 제외만 ──
  router.post("/api/review/bulk-decision", async (ctx: Ctx) => {
    const body = await ctx.body<BulkBody>();
    const ids = body.itemIds;
    if (!Array.isArray(ids) || ids.length === 0) throw badRequest("itemIds 가 필요합니다");
    if (ids.length > 100) throw badRequest("한 번에 100건까지만 처리합니다");
    if (!ids.every((v) => typeof v === "string")) throw badRequest("itemIds 는 문자열 배열이어야 합니다");
    const reason = str(body.reason, "reason");

    // ❗ 일괄 **승인은 제공하지 않는다.** 승인은 이메일 MX 통과가 필요하고, 그것은
    //    항목마다 사람이 확인해야 하는 일이다 (설계서 8.2).
    const userId = ctx.userId;
    const outcomes: Array<{ itemId: string; ok: boolean; error?: string }> = [];
    for (const itemId of ids as string[]) {
      try {
        await deps.session.asUser(userId, (tx) => tx`
          select public.decide_review_item(${itemId}, 'rejected'::review_status, ${reason}, null)
        `);
        outcomes.push({ itemId, ok: true });
      } catch (err) {
        // 한 건이 실패해도 나머지를 계속한다. 실패를 조용히 버리지 않고 그대로 돌려준다.
        outcomes.push({ itemId, ok: false, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
      }
    }
    return { data: outcomes, meta: { requested: ids.length, rejected: outcomes.filter((o) => o.ok).length } };
  });

  return router;
}
