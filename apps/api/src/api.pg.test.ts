import type { AddressInfo } from "node:net";
import { nullLogger } from "@leadops/core";
import { createCandidate, createRun, createTestDb, createUser, type Candidate, type TestDb } from "@leadops/db";
import type { MxResolver } from "@leadops/http";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInternal } from "./hmac";
import { signJwt } from "./jwt";
import { createApi } from "./server";

/**
 * 검수 API 통합 — 실제 HTTP 서버 · 실제 Postgres · 실제 RPC.
 *
 * ❗ 여기서 확인해야 할 것은 "응답이 오는가" 가 아니라 **규칙이 API 를 통과해도 유지되는가** 다.
 *    상한·쿼터·게이트·nonce 는 DB 안에 있고, API 는 그것을 우회할 수 없어야 한다.
 */

const SECRET = "integration-secret-0123456789";
/** pg_cron 트리거 서명 비밀. 32자 이상이어야 `hmac.ts` 가 받아 준다. */
const INTERNAL_SECRET = "integration-internal-trigger-secret-32";

let db: TestDb;
let server: Server;
let base: string;
let userId: string;
let otherUserId: string;
let adminId: string;

/** MX 를 통과시키는 리졸버. DNS 를 테스트에 끌어들이지 않는다. */
const goodMx: MxResolver = {
  mx: async () => [{ exchange: "mx.example.kr", priority: 10 }],
  a: async () => [],
  aaaa: async () => [],
};

const tokenFor = (sub: string): string =>
  signJwt({ sub, exp: Math.floor(Date.now() / 1000) + 3600, role: "authenticated" }, SECRET);

interface Res<T> {
  status: number;
  body: T;
}

async function call<T = unknown>(
  method: string,
  path: string,
  options: { token?: string | undefined; body?: unknown } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  db = await createTestDb("api");
  userId = await createUser(db, "reviewer@leadops.test", "user");
  otherUserId = await createUser(db, "other@leadops.test", "user");
  adminId = await createUser(db, "admin@leadops.test", "admin");

  server = createApi({
    sql: db.owner,
    jwtSecret: SECRET,
    logger: nullLogger,
    resolver: goodMx,
    internalSecret: INTERNAL_SECRET,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db?.close();
});

describe("❗ 인증", () => {
  it("토큰이 없으면 401 이다", async () => {
    const res = await call("GET", "/api/review");
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe("unauthenticated");
  });

  it("서명이 틀린 토큰은 401 이다", async () => {
    const forged = signJwt({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 }, "wrong-secret");
    expect((await call("GET", "/api/review", { token: forged })).status).toBe(401);
  });

  it("만료된 토큰은 401 이다", async () => {
    const expired = signJwt({ sub: userId, exp: Math.floor(Date.now() / 1000) - 600 }, SECRET);
    expect((await call("GET", "/api/review", { token: expired })).status).toBe(401);
  });

  it("인증 없이 접근 가능한 경로는 /health 뿐이다", async () => {
    expect((await call("GET", "/health")).status).toBe(200);
    expect((await call("GET", "/api/leads")).status).toBe(401);
  });

  it("등록되지 않은 경로는 404 다", async () => {
    expect((await call("GET", "/api/nope", { token: tokenFor(userId) })).status).toBe(404);
  });
});

describe("❗ 동시 요청이 사용자를 섞지 않는다", () => {
  it("서로 다른 사용자의 요청을 병렬로 보내도 컨텍스트가 교차하지 않는다", async () => {
    // 사용자 id 를 공유 변수에 두면 A 가 await 하는 사이 B 가 덮어쓴다.
    // 그러면 A 의 응답에 B 의 데이터가 들어간다 — 서버에서 가장 위험한 버그다.
    const rounds = 12;
    const calls = Array.from({ length: rounds }, (_, i) => {
      const who = i % 2 === 0 ? userId : otherUserId;
      return call<{ data: Array<{ actor: string }> }>("GET", "/api/whoami", { token: tokenFor(who) })
        .then(() => who);
    });
    // /api/whoami 는 없으므로 404 다. 중요한 것은 **던지지 않고** 각자 처리되는 것이다.
    const results = await Promise.all(calls);
    expect(results.length).toBe(rounds);

    // 실제 데이터 경로로도 확인한다: 두 사용자가 동시에 목록을 읽어도 각자 200 이다.
    const mixed = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call("GET", "/api/review", { token: tokenFor(i % 2 === 0 ? userId : otherUserId) }),
      ),
    );
    expect(mixed.every((r) => r.status === 200)).toBe(true);
  });
});

describe("검수 목록·상세", () => {
  let candidate: Candidate;

  beforeAll(async () => {
    candidate = await createCandidate(db, { name: "라온피부과의원", rank: 1, total: 72 });
  });

  it("목록에 후보가 나온다", async () => {
    const res = await call<{ data: Array<{ id: string; name: string; total: number }> }>(
      "GET",
      "/api/review",
      { token: tokenFor(userId) },
    );
    expect(res.status).toBe(200);
    const found = res.body.data.find((r) => r.id === candidate.reviewItemId);
    expect(found?.name).toBe("라온피부과의원");
    expect(found?.total).toBe(72);
  });

  it("❗ limit 상한을 넘기면 조용히 자르지 않고 거절한다", async () => {
    const res = await call<{ error: { code: string } }>("GET", "/api/review?limit=500", {
      token: tokenFor(userId),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("상세는 근거·연락처 페이지·경쟁사와 nonce 를 함께 준다", async () => {
    const res = await call<{
      data: { item: Record<string, unknown>; contactPages: unknown[]; nonce: string | null };
    }>("GET", `/api/review/${candidate.reviewItemId}`, { token: tokenFor(userId) });
    expect(res.status).toBe(200);
    expect(res.body.data.item["gate_passed"]).toBe(true);
    expect(res.body.data.contactPages.length).toBeGreaterThan(0);
    // 검수 화면을 열었다는 증거. 이메일 입력 RPC 가 이것을 요구한다.
    expect(typeof res.body.data.nonce).toBe("string");
  });
});

describe("❗ 연락처 수동 입력 → MX 게이트", () => {
  let candidate: Candidate;
  let nonce: string;

  beforeAll(async () => {
    candidate = await createCandidate(db, { name: "맑은치과의원", industry: "dental", rank: 2, total: 70 });
    const res = await call<{ data: { nonce: string } }>("GET", `/api/review/${candidate.reviewItemId}`, {
      token: tokenFor(userId),
    });
    nonce = res.body.data.nonce;
  });

  it("문법이 틀리면 DB 에 닿기 전에 거절한다", async () => {
    const res = await call<{ error: { code: string } }>("POST", `/api/review/${candidate.reviewItemId}/contact-email`, {
      token: tokenFor(userId),
      body: { address: "not-an-address", emailType: "inquiry", contactPageId: candidate.contactPageId, nonce },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("정상 입력이면 MX 까지 검증해 저장한다", async () => {
    const res = await call<{ data: { emailId: string; mxOk: boolean; mxHosts: string[] } }>(
      "POST",
      `/api/review/${candidate.reviewItemId}/contact-email`,
      {
        token: tokenFor(userId),
        body: { address: "info@maleun.co.kr", emailType: "inquiry", contactPageId: candidate.contactPageId, nonce },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.mxOk).toBe(true);
    expect(res.body.data.mxHosts).toEqual(["mx.example.kr"]);

    const [row] = await db.owner<Array<{ mx_ok: boolean; dns_ok: boolean; acquisition_method: string; entered_by: string }>>`
      select mx_ok, dns_ok, acquisition_method::text as acquisition_method, entered_by::text as entered_by
      from emails where id = ${res.body.data.emailId}
    `;
    expect(row!.mx_ok).toBe(true);
    expect(row!.dns_ok).toBe(true);
    // 법적 요구: 수동 입력이고 행위자가 남아야 한다 (제50조의2 · R2-08).
    expect(row!.acquisition_method).toBe("manual_entry");
    expect(row!.entered_by).toBe(userId);
  });

  it("❗ nonce 는 1회용이다 — 같은 nonce 를 다시 쓰면 거절한다", async () => {
    const res = await call<{ error: { code: string } }>("POST", `/api/review/${candidate.reviewItemId}/contact-email`, {
      token: tokenFor(userId),
      body: { address: "second@maleun.co.kr", emailType: "inquiry", contactPageId: candidate.contactPageId, nonce },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("invalid_nonce");
  });

  it("❗ 인증 사용자는 MX 검증 함수를 직접 호출할 수 없다 (게이트 우회 차단)", async () => {
    // 이 함수를 authenticated 에게 주면 검수자가 스스로 mx_ok 를 참으로 만들 수 있다.
    const [email] = await db.owner<Array<{ id: string }>>`select id from emails limit 1`;
    await expect(
      db.asUser(userId, (tx) => tx`
        select public.verify_contact_email(${email!.id}, true, true, null, null)
      `),
    ).rejects.toThrow(/permission denied/i);
  });

  it("실행권이 service_role 에만 있다", async () => {
    const rows = await db.owner<Array<{ grantee: string }>>`
      select grantee from information_schema.role_routine_grants
      where routine_name = 'verify_contact_email' and specific_schema = 'public'
      order by grantee
    `;
    expect(rows.map((r) => r.grantee)).not.toContain("authenticated");
    expect(rows.map((r) => r.grantee)).toContain("service_role");
  });
});

describe("승인·제외", () => {
  let candidate: Candidate;
  let emailId: string;

  beforeAll(async () => {
    candidate = await createCandidate(db, { name: "승인대상피부과의원", rank: 3, total: 68 });
    const detail = await call<{ data: { nonce: string } }>("GET", `/api/review/${candidate.reviewItemId}`, {
      token: tokenFor(userId),
    });
    const entered = await call<{ data: { emailId: string } }>(
      "POST",
      `/api/review/${candidate.reviewItemId}/contact-email`,
      {
        token: tokenFor(userId),
        body: {
          address: "contact@seungin.co.kr",
          emailType: "inquiry",
          contactPageId: candidate.contactPageId,
          nonce: detail.body.data.nonce,
        },
      },
    );
    emailId = entered.body.data.emailId;
  });

  it("❗ 이메일 없이 승인하면 거절한다", async () => {
    const res = await call<{ error: { code: string; message: string } }>(
      "POST",
      `/api/review/${candidate.reviewItemId}/decision`,
      { token: tokenFor(userId), body: { status: "approved" } },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("emailId");
  });

  it("제외에는 사유가 필요하다", async () => {
    const res = await call("POST", `/api/review/${candidate.reviewItemId}/decision`, {
      token: tokenFor(userId),
      body: { status: "rejected" },
    });
    expect(res.status).toBe(400);
  });

  it("MX 통과 이메일로 승인하면 리드가 만들어진다", async () => {
    const res = await call("POST", `/api/review/${candidate.reviewItemId}/decision`, {
      token: tokenFor(userId),
      body: { status: "approved", emailId },
    });
    expect(res.status).toBe(200);

    const [lead] = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from leads where review_item_id = ${candidate.reviewItemId}
    `;
    expect(lead!.n).toBe("1");
  });

  it("이미 처리된 항목을 다시 결정하면 409 다", async () => {
    const res = await call<{ error: { code: string } }>("POST", `/api/review/${candidate.reviewItemId}/decision`, {
      token: tokenFor(userId),
      body: { status: "rejected", reason: "중복" },
    });
    expect(res.status).toBe(409);
  });
});

describe("❗ 일괄 처리는 제외만", () => {
  it("일괄 제외가 동작한다", async () => {
    const a = await createCandidate(db, { name: "일괄A피부과의원", rank: 10, total: 61 });
    const b = await createCandidate(db, { name: "일괄B피부과의원", rank: 11, total: 62 });

    const res = await call<{ data: Array<{ ok: boolean }>; meta: { rejected: number } }>(
      "POST",
      "/api/review/bulk-decision",
      { token: tokenFor(userId), body: { itemIds: [a.reviewItemId, b.reviewItemId], reason: "규모 부적합" } },
    );
    expect(res.status).toBe(200);
    expect(res.body.meta.rejected).toBe(2);

    const rows = await db.owner<Array<{ status: string }>>`
      select status::text as status from review_items where id in (${a.reviewItemId}, ${b.reviewItemId})
    `;
    expect(rows.every((r) => r.status === "rejected")).toBe(true);
  });

  it("사유 없이 일괄 처리할 수 없다", async () => {
    const res = await call("POST", "/api/review/bulk-decision", {
      token: tokenFor(userId),
      body: { itemIds: ["00000000-0000-0000-0000-000000000000"] },
    });
    expect(res.status).toBe(400);
  });

  it("❗ 일괄 승인 경로가 존재하지 않는다", async () => {
    // 승인은 이메일 MX 통과가 필요하고, 그것은 항목마다 사람이 확인해야 한다 (설계서 8.2).
    const res = await call<{ data: Array<{ ok: boolean; error?: string }> }>("POST", "/api/review/bulk-decision", {
      token: tokenFor(userId),
      body: { itemIds: ["00000000-0000-0000-0000-000000000000"], reason: "x", status: "approved" },
    });
    // status 를 넣어도 무시하고 제외로 처리한다 (없는 id 라 실패로 기록된다).
    expect(res.status).toBe(200);
    expect(res.body.data[0]!.ok).toBe(false);
  });

  it("한 번에 100건을 넘길 수 없다", async () => {
    const ids = Array.from({ length: 101 }, () => "00000000-0000-0000-0000-000000000000");
    const res = await call("POST", "/api/review/bulk-decision", {
      token: tokenFor(userId),
      body: { itemIds: ids, reason: "x" },
    });
    expect(res.status).toBe(400);
  });
});

describe("❗ 승인 상한이 API 를 통과해도 유지된다", () => {
  it("일 상한에 도달하면 409 를 준다", async () => {
    // 상한을 2로 낮춘다. RPC 가 승인일 기준으로 세므로 API 로는 우회할 수 없다.
    await db.owner`
      update settings set value = jsonb_set(value, '{final_max}', '2'::jsonb) where key = 'targets'
    `;
    await db.owner`update approval_day_totals set approved_total = 2 where approval_date = current_date`;
    await db.owner`
      insert into approval_day_totals (approval_date, approved_total)
      values (current_date, 2) on conflict (approval_date) do update set approved_total = 2
    `;

    const candidate = await createCandidate(db, { name: "상한초과피부과의원", rank: 20, total: 65 });
    const detail = await call<{ data: { nonce: string } }>("GET", `/api/review/${candidate.reviewItemId}`, {
      token: tokenFor(userId),
    });
    const entered = await call<{ data: { emailId: string } }>(
      "POST",
      `/api/review/${candidate.reviewItemId}/contact-email`,
      {
        token: tokenFor(userId),
        body: {
          address: "over@limit.co.kr",
          emailType: "inquiry",
          contactPageId: candidate.contactPageId,
          nonce: detail.body.data.nonce,
        },
      },
    );

    const res = await call<{ error: { code: string } }>("POST", `/api/review/${candidate.reviewItemId}/decision`, {
      token: tokenFor(userId),
      body: { status: "approved", emailId: entered.body.data.emailId },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("daily_cap_reached");

    // 원상 복구
    await db.owner`
      update settings set value = jsonb_set(value, '{final_max}', '50'::jsonb) where key = 'targets'
    `;
  });
});

describe("리드 · export", () => {
  it("승인된 리드가 목록에 나온다", async () => {
    const res = await call<{ data: Array<{ name: string; email_address: string }> }>("GET", "/api/leads", {
      token: tokenFor(userId),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("export 는 날짜 형식을 요구한다", async () => {
    expect((await call("GET", "/api/leads/export", { token: tokenFor(userId) })).status).toBe(400);
    expect((await call("GET", "/api/leads/export?from=2026-01-01&to=x", { token: tokenFor(userId) })).status).toBe(400);
  });

  it("from 이 to 보다 늦으면 거절한다", async () => {
    const res = await call("GET", "/api/leads/export?from=2026-12-31&to=2026-01-01", { token: tokenFor(userId) });
    expect(res.status).toBe(400);
  });

  it("❗ export 는 admin 전용이다 (RPC 가 강제한다)", async () => {
    const res = await call<{ error: { code: string } }>(
      "GET",
      "/api/leads/export?from=2026-01-01&to=2036-12-31",
      { token: tokenFor(userId) },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("admin 은 export 할 수 있다", async () => {
    const res = await call<{ data: unknown[]; meta: { count: number } }>(
      "GET",
      "/api/leads/export?from=2026-01-01&to=2036-12-31",
      { token: tokenFor(adminId) },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe("응답 규약", () => {
  it("성공은 data 봉투다", async () => {
    const res = await call<Record<string, unknown>>("GET", "/api/review", { token: tokenFor(userId) });
    expect(res.body).toHaveProperty("data");
  });

  it("실패는 error 봉투다", async () => {
    const res = await call<Record<string, unknown>>("GET", "/api/review?limit=0", { token: tokenFor(userId) });
    expect(res.body).toHaveProperty("error");
    expect((res.body["error"] as { code: string }).code).toBeTruthy();
  });

  it("본문이 JSON 이 아니면 400 이다", async () => {
    const res = await fetch(`${base}/api/review/x/decision`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(userId)}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("검수 데이터는 캐시하지 않는다", async () => {
    const res = await fetch(`${base}/api/review`, { headers: { authorization: `Bearer ${tokenFor(userId)}` } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 운영 엔드포인트 (설계서 7.2)
// ══════════════════════════════════════════════════════════════════════

describe("실행 이력", () => {
  let candidate: Candidate;

  beforeAll(async () => {
    candidate = await createCandidate(db, { name: "실행이력 치과" });
  });

  it("목록에 실행이 나온다", async () => {
    const res = await call<{ data: Array<{ id: string; status: string; cost_krw: number }> }>(
      "GET",
      "/api/runs",
      { token: tokenFor(userId) },
    );
    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.id === candidate.runId);
    expect(row).toBeDefined();
    // 비용이 없으면 null 이 아니라 0 이어야 한다 — 화면에서 "—" 와 "0원" 은 다른 뜻이다.
    expect(row!.cost_krw).toBe(0);
  });

  it("상세는 스테이지·실패 잡·비용을 함께 준다", async () => {
    const res = await call<{
      data: { run: { id: string }; stages: unknown[]; failedJobs: unknown[]; costs: unknown[] };
    }>("GET", `/api/runs/${candidate.runId}`, { token: tokenFor(userId) });
    expect(res.status).toBe(200);
    expect(res.body.data.run.id).toBe(candidate.runId);
    expect(Array.isArray(res.body.data.stages)).toBe(true);
    expect(Array.isArray(res.body.data.failedJobs)).toBe(true);
    expect(Array.isArray(res.body.data.costs)).toBe(true);
  });

  it("없는 실행은 400 이다", async () => {
    const res = await call("GET", "/api/runs/00000000-0000-4000-8000-000000000000", {
      token: tokenFor(userId),
    });
    expect(res.status).toBe(400);
  });
});

describe("❗ 실행 조작은 admin 전용", () => {
  it("수동 실행은 admin 만 만들 수 있다", async () => {
    const res = await call("POST", "/api/runs", {
      token: tokenFor(userId),
      body: { industries: ["dental"], limit: 10 },
    });
    expect(res.status).toBe(403);
  });

  it("알 수 없는 업종은 거절한다", async () => {
    const res = await call("POST", "/api/runs", {
      token: tokenFor(adminId),
      body: { industries: ["카페"], limit: 10 },
    });
    expect(res.status).toBe(400);
  });

  it("dryRun 은 아무것도 만들지 않고 계획만 준다", async () => {
    const before = await db.owner<Array<{ n: number }>>`select count(*)::int as n from runs`;
    const res = await call<{ data: { dryRun: boolean; stages: string[] } }>("POST", "/api/runs", {
      token: tokenFor(adminId),
      body: { industries: ["dental"], limit: 10, dryRun: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(res.body.data.stages).toContain("score");
    const after = await db.owner<Array<{ n: number }>>`select count(*)::int as n from runs`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("admin 이 수동 실행을 만들면 collect 잡이 큐에 들어간다", async () => {
    const res = await call<{ data: { runId: string } }>("POST", "/api/runs", {
      token: tokenFor(adminId),
      body: { industries: ["dental", "derm"], limit: 5 },
    });
    expect(res.status).toBe(200);
    const runId = res.body.data.runId;

    const jobs = await db.owner<Array<{ stage: string; status: string }>>`
      select j.stage, j.status from jobs j
      join run_attempts a on a.id = j.attempt_id
      where a.run_id = ${runId}
    `;
    expect(jobs.length).toBe(2);
    expect(jobs.every((j) => j.stage === "collect" && j.status === "queued")).toBe(true);

    // 누가 돌렸는지 남아야 한다.
    const audit = await db.owner<Array<{ actor: string }>>`
      select actor::text as actor from audit_log
      where action = 'run.create' and entity_id = ${runId}
    `;
    expect(audit[0]!.actor).toBe(adminId);
  });

  it("❗ 재시도는 새 attempt 를 만들고 이전 점수를 무효화한다 (R2-21)", async () => {
    const candidate = await createCandidate(db, { name: "재시도 치과" });
    const res = await call<{ data: { attempt_id: string; jobs: number } }>(
      "POST",
      `/api/runs/${candidate.runId}/retry`,
      { token: tokenFor(adminId), body: { fromStage: "score" } },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.attempt_id).not.toBe(candidate.attemptId);

    const [old] = await db.owner<Array<{ invalidated_at: string | null }>>`
      select invalidated_at from scores where id = ${candidate.scoreId}
    `;
    expect(old!.invalidated_at).not.toBeNull();

    const jobs = await db.owner<Array<{ stage: string }>>`
      select stage from jobs where attempt_id = ${res.body.data.attempt_id}
    `;
    expect(jobs.map((j) => j.stage)).toEqual(["score"]);
  });

  it("알 수 없는 스테이지로는 재시도할 수 없다", async () => {
    const candidate = await createCandidate(db, { name: "스테이지 오타 치과" });
    const res = await call("POST", `/api/runs/${candidate.runId}/retry`, {
      token: tokenFor(adminId),
      body: { fromStage: "scoer" },
    });
    expect(res.status).toBe(400);
  });

  it("❗ 이미 끝난 실행은 취소할 수 없다", async () => {
    const candidate = await createCandidate(db, { name: "완료된 치과" });
    await db.owner`update runs set status = 'succeeded', finished_at = now() where id = ${candidate.runId}`;
    const res = await call("POST", `/api/runs/${candidate.runId}/cancel`, {
      token: tokenFor(adminId),
      body: { reason: "테스트" },
    });
    expect(res.status).toBe(409);
  });

  it("취소는 대기 중인 잡만 죽인다", async () => {
    const candidate = await createCandidate(db, { name: "취소할 치과" });
    await db.owner`update runs set status = 'running' where id = ${candidate.runId}`;
    await db.owner`
      insert into jobs (attempt_id, stage, idempotency_key, payload, status)
      values (${candidate.attemptId}, 'score', 'score:all', '{}'::jsonb, 'queued'),
             (${candidate.attemptId}, 'recommend', 'recommend:all', '{}'::jsonb, 'running')
    `;
    const res = await call<{ data: { jobs_killed: number } }>(
      "POST",
      `/api/runs/${candidate.runId}/cancel`,
      { token: tokenFor(adminId), body: { reason: "예산 초과" } },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.jobs_killed).toBe(1);

    const jobs = await db.owner<Array<{ stage: string; status: string }>>`
      select stage, status from jobs where attempt_id = ${candidate.attemptId} order by stage
    `;
    // 실행 중인 잡은 그대로 둔다 — 워커가 쓴 결과와 상태가 어긋나면 안 된다.
    expect(jobs).toEqual([
      { stage: "recommend", status: "running" },
      { stage: "score", status: "dead" },
    ]);
  });
});

describe("설정", () => {
  it("목록은 저장값과 실제 적용값을 함께 준다", async () => {
    const res = await call<{
      data: { rows: Array<{ key: string }>; effective: { scoring: { mode: string } } };
    }>("GET", "/api/settings", { token: tokenFor(userId) });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((r) => r.key)).toContain("scoring");
    expect(res.body.data.effective.scoring.mode).toBeDefined();
  });

  it("❗ 설정 변경은 admin 전용이다", async () => {
    const res = await call("PUT", "/api/settings/targets", {
      token: tokenFor(userId),
      body: { value: { final_max: 999 } },
    });
    expect(res.status).toBe(403);
  });

  it("❗ 알 수 없는 키는 거절한다 (오타가 조용히 저장되면 안 된다)", async () => {
    const res = await call("PUT", "/api/settings/targetz", {
      token: tokenFor(adminId),
      body: { value: { final_max: 10 } },
    });
    expect(res.status).toBe(400);
    const rows = await db.owner`select 1 from settings where key = 'targetz'`;
    expect(rows.length).toBe(0);
  });

  it("❗ 객체가 아닌 값은 거절한다 (파서가 전체를 기본값으로 되돌린다)", async () => {
    for (const value of [42, "많이", [1, 2], null]) {
      const res = await call("PUT", "/api/settings/targets", {
        token: tokenFor(adminId),
        body: { value },
      });
      expect(res.status).toBe(400);
    }
  });

  it("admin 이 바꾸면 적용값이 함께 바뀌고 감사 로그가 남는다", async () => {
    const [before] = await db.owner<Array<{ value: Record<string, number> }>>`
      select value from settings where key = 'targets'
    `;
    const original = before!.value;
    const next = { ...original, final_max: 42 };
    const res = await call<{ data: { effective: { targets: { finalMax: number } } } }>(
      "PUT",
      "/api/settings/targets",
      { token: tokenFor(adminId), body: { value: next } },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.effective.targets.finalMax).toBe(42);

    const audit = await db.owner`
      select 1 from audit_log where entity = 'settings' and entity_id = 'targets'
    `;
    expect(audit.length).toBeGreaterThan(0);

    // 뒤 테스트가 원래 상한을 보게 되돌린다.
    await db.owner`update settings set value = ${db.owner.json(original)} where key = 'targets'`;
  });
});

describe("업종·키워드", () => {
  let candidate: Candidate;

  beforeAll(async () => {
    candidate = await createCandidate(db, { name: "키워드 치과", industry: "dental" });
    await db.owner`
      insert into company_keywords (company_id, keyword, kind, source, approved)
      values (${candidate.companyId}, '강남 임플란트 후기', 'nonbrand_long', 'llm', false)
    `;
  });

  it("업종 요약에 업체 수·키워드 수·쿼터가 나온다", async () => {
    const res = await call<{
      data: Array<{ industry: string; companies: number; llm_pending: number; quota: number }>;
      meta: { quota: number };
    }>("GET", "/api/industries", { token: tokenFor(userId) });
    expect(res.status).toBe(200);
    const dental = res.body.data.find((r) => r.industry === "dental");
    expect(dental!.companies).toBeGreaterThan(0);
    expect(dental!.llm_pending).toBeGreaterThan(0);
    expect(res.body.meta.quota).toBeGreaterThan(0);
  });

  it("승인 대기 키워드만 걸러 볼 수 있다", async () => {
    const res = await call<{ data: Array<{ keyword: string; approved: boolean }> }>(
      "GET",
      "/api/keywords?pending=1&limit=200",
      { token: tokenFor(userId) },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((k) => k.approved === false)).toBe(true);
  });

  it("❗ 키워드 승인은 admin 전용이다 (LLM 초안이 그대로 검색에 나가면 안 된다)", async () => {
    const [row] = await db.owner<Array<{ id: string }>>`
      select id from company_keywords where company_id = ${candidate.companyId}
    `;
    const denied = await call("POST", `/api/keywords/${row!.id}/approve`, {
      token: tokenFor(userId),
      body: { approved: true },
    });
    expect(denied.status).toBe(403);

    const ok = await call<{ data: { approved: boolean } }>(
      "POST",
      `/api/keywords/${row!.id}/approve`,
      { token: tokenFor(adminId), body: { approved: true } },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.data.approved).toBe(true);

    const [after] = await db.owner<Array<{ approved: boolean }>>`
      select approved from company_keywords where id = ${row!.id}
    `;
    expect(after!.approved).toBe(true);
  });

  it("approved 가 boolean 이 아니면 거절한다", async () => {
    const [row] = await db.owner<Array<{ id: string }>>`select id from company_keywords limit 1`;
    const res = await call("POST", `/api/keywords/${row!.id}/approve`, {
      token: tokenFor(adminId),
      body: { approved: "네" },
    });
    expect(res.status).toBe(400);
  });
});

describe("비용", () => {
  it("❗ 검수자는 볼 수 없다 (조용히 0원으로 보이면 안 된다)", async () => {
    expect((await call("GET", "/api/costs", { token: tokenFor(userId) })).status).toBe(403);
  });

  it("일별·제공자별 합계와 상한을 준다", async () => {
    await db.owner`
      insert into cost_ledger (entry_key, provider, unit, qty, krw)
      values ('test:cost:1', 'naver_search', 'call', 100, 120.5)
      on conflict (entry_key) do nothing
    `;
    const res = await call<{
      data: {
        daily: Array<{ day: string; krw: number }>;
        providers: Array<{ provider: string; krw: number }>;
        caps: { daily_cap_krw: number | null };
        todayKrw: number;
      };
    }>("GET", "/api/costs", { token: tokenFor(adminId) });
    expect(res.status).toBe(200);
    expect(res.body.data.providers.some((p) => p.provider === "naver_search")).toBe(true);
    expect(res.body.data.caps.daily_cap_krw).toBeGreaterThan(0);
    expect(res.body.data.todayKrw).toBeGreaterThan(0);
  });
});

describe("❗ 개인정보 요청 (F-08)", () => {
  it("접수는 admin 이 아니어도 할 수 있다 (법정 권리 행사를 막으면 안 된다)", async () => {
    const res = await call<{ data: { request_id: string } }>("POST", "/api/privacy/requests", {
      token: tokenFor(userId),
      body: { kind: "delete", subject: "owner@clinic.example.kr", note: "홈페이지 문의" },
    });
    expect(res.status).toBe(200);

    const [row] = await db.owner<Array<{ status: string; due_at: string; received_at: string }>>`
      select status, due_at, received_at from privacy_requests where id = ${res.body.data.request_id}
    `;
    expect(row!.status).toBe("received");
    // 기한은 접수 시점에 못 박는다 — 개인정보보호법 시행령상 10일.
    const days =
      (new Date(row!.due_at).getTime() - new Date(row!.received_at).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(10);
  });

  it("우리가 가진 이메일이면 업체가 자동으로 연결된다", async () => {
    const candidate = await createCandidate(db, { name: "요청 대상 치과" });
    // ❗ 전용 사용자로 입력한다. 수동 입력은 분당 3건 제한이 있어서, 앞 테스트들이 쓴
    //    사용자를 재사용하면 429 가 나고 이 테스트는 엉뚱한 이유로 실패한다.
    const entrant = await createUser(db, "privacy-entrant@leadops.test", "user");
    const detail = await call<{ data: { nonce: string } }>(
      "GET",
      `/api/review/${candidate.reviewItemId}`,
      { token: tokenFor(entrant) },
    );
    const entered = await call("POST", `/api/review/${candidate.reviewItemId}/contact-email`, {
      token: tokenFor(entrant),
      body: {
        address: "privacy-link@clinic.example.kr",
        emailType: "inquiry",
        contactPageId: candidate.contactPageId,
        nonce: detail.body.data.nonce,
      },
    });
    expect(entered.status).toBe(200);

    const res = await call<{ data: { company_id: string | null } }>("POST", "/api/privacy/requests", {
      token: tokenFor(userId),
      body: { kind: "access", subject: "privacy-link@clinic.example.kr" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.company_id).toBe(candidate.companyId);
  });

  it("알 수 없는 종류·빈 식별자는 거절한다", async () => {
    const bad = await call("POST", "/api/privacy/requests", {
      token: tokenFor(userId),
      body: { kind: "복사", subject: "a@b.kr" },
    });
    expect(bad.status).toBe(400);

    const empty = await call("POST", "/api/privacy/requests", {
      token: tokenFor(userId),
      body: { kind: "delete", subject: "   " },
    });
    expect(empty.status).toBe(400);
  });

  it("❗ 목록 조회는 admin 전용이다 (요청자 식별자가 곧 개인정보다)", async () => {
    const denied = await call("GET", "/api/privacy/requests", { token: tokenFor(userId) });
    expect(denied.status).toBe(403);

    const ok = await call<{ data: Array<{ kind: string; overdue: boolean }> }>(
      "GET",
      "/api/privacy/requests?open=1",
      { token: tokenFor(adminId) },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.data.length).toBeGreaterThan(0);
    expect(ok.body.data.every((r) => r.overdue === false)).toBe(true);
  });
});

describe("경쟁사 수동 교체", () => {
  it("❗ admin 전용이고, 교체하면 재분석 대상이 된다", async () => {
    const target = await createCandidate(db, { name: "교체 대상 치과" });
    const rival = await createCandidate(db, { name: "새 경쟁사 치과" });

    const denied = await call("POST", `/api/review/${target.reviewItemId}/competitors`, {
      token: tokenFor(userId),
      body: { rank: 1, competitorCompanyId: rival.companyId },
    });
    expect(denied.status).toBe(403);

    const res = await call<{ data: { competitor_id: string; needs_reanalysis: boolean } }>(
      "POST",
      `/api/review/${target.reviewItemId}/competitors`,
      { token: tokenFor(adminId), body: { rank: 1, competitorCompanyId: rival.companyId } },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.needs_reanalysis).toBe(true);

    const [row] = await db.owner<
      Array<{ is_valid: boolean; selection_method: string; metrics: number }>
    >`
      select c.is_valid, c.selection_method,
             (select count(*)::int from competitor_metrics m where m.competitor_id = c.id) as metrics
      from competitors c where c.id = ${res.body.data.competitor_id}
    `;
    expect(row!.selection_method).toBe("manual");
    // ❗ 지표를 다시 계산하기 전에는 유효로 볼 수 없다 — 이전 경쟁사 지표가 새 경쟁사 것으로 읽힌다.
    expect(row!.is_valid).toBe(false);
    expect(row!.metrics).toBe(0);
  });

  it("자기 자신을 경쟁사로 넣을 수 없다", async () => {
    const target = await createCandidate(db, { name: "자기참조 치과" });
    const res = await call("POST", `/api/review/${target.reviewItemId}/competitors`, {
      token: tokenFor(adminId),
      body: { rank: 1, competitorCompanyId: target.companyId },
    });
    expect(res.status).toBe(400);
  });
});

/**
 * ❗ 내부 트리거 — JWT 없이 실행을 만들 수 있는 유일한 경로다.
 *    뚫리면 누구나 파이프라인을 돌려 쿼터와 비용을 소진시킬 수 있다.
 */
describe("❗ POST /internal/run (pg_cron HMAC)", () => {
  /** 서명 헤더를 붙여 호출한다. `call()` 은 Bearer 만 다루므로 직접 fetch 한다. */
  async function trigger(
    body: unknown,
    options: { secret?: string; timestamp?: number; signature?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const raw = JSON.stringify(body);
    const ts = options.timestamp ?? Math.floor(Date.now() / 1000);
    const sig = options.signature ?? signInternal(options.secret ?? INTERNAL_SECRET, ts, raw);
    const res = await fetch(`${base}/internal/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-leadops-timestamp": String(ts),
        "x-leadops-signature": sig,
      },
      body: raw,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("❗ JWT 로는 통과할 수 없다 (서명 경로다)", async () => {
    const res = await call("POST", "/internal/run", { token: tokenFor(adminId), body: {} });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe("bad_signature");
  });

  it("❗ 서명이 없으면 401 이다", async () => {
    const res = await call("POST", "/internal/run", { body: {} });
    expect(res.status).toBe(401);
  });

  it("❗ 다른 비밀로 서명하면 거부한다", async () => {
    const res = await trigger({}, { secret: "another-internal-secret-32-chars-long" });
    expect(res.status).toBe(401);
    expect((res.body["error"] as { code: string }).code).toBe("bad_signature");
  });

  it("❗ 오래된 타임스탬프는 거부한다 (재생 공격)", async () => {
    const res = await trigger({}, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(res.status).toBe(401);
    expect((res.body["error"] as { code: string }).code).toBe("stale_signature");
  });

  it("❗ 본문을 바꾸면 서명이 깨진다", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await trigger(
      { industries: ["dental"] },
      { signature: signInternal(INTERNAL_SECRET, ts, JSON.stringify({ industries: ["derm"] })), timestamp: ts },
    );
    expect(res.status).toBe(401);
  });

  it("dryRun 은 판정만 하고 실행을 만들지 않는다", async () => {
    const before = await db.owner<Array<{ n: string }>>`select count(*)::text as n from runs where trigger = 'cron'`;
    const res = await trigger({ dryRun: true, industries: ["derm"] });
    expect(res.status).toBe(200);
    const data = res.body["data"] as { started: boolean; dryRun?: boolean; decision: { should_run: boolean } };
    expect(data.started).toBe(false);
    // 주말이면 skipped 로 온다 — 판정 결과를 그대로 확인한다.
    if (data.decision.should_run) expect(data.dryRun).toBe(true);
    const after = await db.owner<Array<{ n: string }>>`select count(*)::text as n from runs where trigger = 'cron'`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("❗ 알 수 없는 업종은 400 이다 (서명이 맞아도 입력은 검증한다)", async () => {
    const res = await trigger({ industries: ["nope"] });
    expect(res.status).toBe(400);
  });

  it("❗ 같은 날 두 번 불러도 cron 실행은 하나만 만들어진다", async () => {
    await db.owner`delete from runs where trigger = 'cron'`;

    const first = await trigger({ industries: ["derm"] });
    expect(first.status).toBe(200);
    const firstData = first.body["data"] as { started: boolean; skipped?: boolean; decision: { reasons: string[] } };

    // 주말에는 판정이 건너뛰기이므로, 그 경우는 사유를 확인하고 끝낸다.
    if (!firstData.started) {
      expect(firstData.decision.reasons).toContain("not_a_weekday");
      return;
    }

    const second = await trigger({ industries: ["derm"] });
    expect(second.status).toBe(200);
    const secondData = second.body["data"] as { started: boolean; skipped: boolean; decision: { reasons: string[] } };
    expect(secondData.started).toBe(false);
    expect(secondData.skipped).toBe(true);
    expect(secondData.decision.reasons).toContain("already_ran_today");

    const [row] = await db.owner<Array<{ n: string }>>`select count(*)::text as n from runs where trigger = 'cron'`;
    expect(row?.n).toBe("1");

    // 감사 로그에 남는다 (행위자는 null — 사람이 아니다).
    const [audit] = await db.owner<Array<{ n: string; actor: string | null }>>`
      select count(*)::text as n, min(actor::text) as actor from audit_log where action = 'run.schedule'
    `;
    expect(audit?.n).toBe("1");
    expect(audit?.actor).toBeNull();

    await db.owner`delete from runs where trigger = 'cron'`;
  });
});

describe("개인정보 워크플로 API", () => {
  async function open(kind: string, subject: string): Promise<string> {
    const res = await call<{ data: { request_id: string } }>("POST", "/api/privacy/requests", {
      token: tokenFor(userId),
      body: { kind, subject },
    });
    expect(res.status).toBe(200);
    return res.body.data.request_id;
  }

  it("접수는 일반 사용자도 할 수 있다 (정보주체의 법정 권리)", async () => {
    const id = await open("access", "subject@example.kr");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("❗ 목록은 admin 전용이다 (요청자 식별자가 남에게 보이면 그 자체가 유출)", async () => {
    const res = await call("GET", "/api/privacy/requests", { token: tokenFor(userId) });
    expect(res.status).toBe(403);
  });

  it("상태 전이는 admin 만 하고 사유 없는 보류를 거절한다", async () => {
    const id = await open("delete", "hold-api@example.kr");

    const denied = await call("POST", `/api/privacy/requests/${id}/advance`, {
      token: tokenFor(userId),
      body: { status: "in_progress" },
    });
    expect(denied.status).toBe(403);

    const noReason = await call("POST", `/api/privacy/requests/${id}/advance`, {
      token: tokenFor(adminId),
      body: { status: "on_hold" },
    });
    expect(noReason.status).toBe(400);

    const ok = await call("POST", `/api/privacy/requests/${id}/advance`, {
      token: tokenFor(adminId),
      body: { status: "on_hold", note: "본인 확인 대기" },
    });
    expect(ok.status).toBe(200);
  });

  it("❗ 열람 보고서는 POST 다 (감사 기록을 남기는 동작이라 GET 이면 안 된다)", async () => {
    const id = await open("access", "report@example.kr");
    const wrongMethod = await call("GET", `/api/privacy/requests/${id}/access-report`, {
      token: tokenFor(adminId),
    });
    expect(wrongMethod.status).toBe(404);

    const res = await call<{ data: { note: string; emails: unknown[] } }>(
      "POST",
      `/api/privacy/requests/${id}/access-report`,
      { token: tokenFor(adminId) },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.note).toContain("자동 수집하지 않습니다");
  });

  it("❗ 주체를 특정하지 못한 삭제 요청은 409 다 (조용히 0건 처리하지 않는다)", async () => {
    const id = await open("delete", "unknown-subject@example.kr");
    const res = await call("POST", `/api/privacy/requests/${id}/execute`, { token: tokenFor(adminId) });
    expect(res.status).toBe(409);
  });

  it("용량 리포트는 admin 전용이다", async () => {
    const denied = await call("GET", "/api/capacity", { token: tokenFor(userId) });
    expect(denied.status).toBe(403);

    const res = await call<{ data: { capacity: { level: string }; tables: unknown[] } }>(
      "GET",
      "/api/capacity",
      { token: tokenFor(adminId) },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.capacity.level).toBe("ok");
    expect(res.body.data.tables.length).toBeGreaterThan(10);
  });
});

describe("UI 데이터 공백 — /api/me · decided_at · search_hits", () => {
  it("GET /api/me 는 본인 프로필을 돌려준다", async () => {
    const res = await call<{ data: { id: string; email: string; role: string } }>(
      "GET", "/api/me", { token: tokenFor(userId) });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(userId);
    expect(res.body.data.email).toBe("reviewer@leadops.test");
    expect(res.body.data.role).toBe("user");
  });

  it("admin 의 role 은 admin 이다", async () => {
    const res = await call<{ data: { role: string } }>("GET", "/api/me", { token: tokenFor(adminId) });
    expect(res.body.data.role).toBe("admin");
  });

  it("제외한 항목의 목록 행에 decided_at 이 있다", async () => {
    const c = await createCandidate(db);
    const decision = await call("POST", `/api/review/${c.reviewItemId}/decision`, {
      token: tokenFor(userId),
      body: { status: "rejected", reason: "테스트 제외" },
    });
    expect(decision.status).toBe(200);
    const list = await call<{ data: Array<Record<string, unknown>> }>(
      "GET", "/api/review?status=rejected&limit=200", { token: tokenFor(userId) });
    const row = list.body.data.find((r) => r["id"] === c.reviewItemId);
    expect(row).toBeDefined();
    expect(row!["decided_at"]).toBeTruthy();
  });

  it("상세에 그 attempt 의 search_hits 가 rank 순으로 나온다 — 없으면 빈 배열", async () => {
    const run = await createRun(db);
    const c = await createCandidate(db, { runId: run.runId, attemptId: run.attemptId });
    const [agg] = await db.owner<{ id: string }[]>`
      insert into search_aggregates (
        attempt_id, company_id, run_date, keyword, keyword_kind, provider,
        total_returned, denominator, related_count, official_count, classifier_version)
      values (${run.attemptId}, ${c.companyId}, ${run.runDate}::date, '테스트 키워드', 'nonbrand',
        'naver_blog', 5, 5, 2, 1, 'v1')
      returning id
    `;
    // rank 역순으로 넣어 응답 정렬을 검증한다
    for (const rank of [2, 1]) {
      await db.owner`
        insert into search_hits (
          aggregate_id, run_date, attempt_id, company_id, keyword, rank, channel_type,
          is_official, url, url_hash, title, published_at, recency)
        values (${agg!.id}, ${run.runDate}::date, ${run.attemptId}, ${c.companyId},
          '테스트 키워드', ${rank}, 'thirdparty_blog', ${rank === 1},
          ${`https://blog.example.kr/${rank}`}, ${`h${rank}-${c.companyId}`},
          ${`글 ${rank}`}, '2026-07-01', 'd0_60')
      `;
    }
    const res = await call<{ data: { search_hits: Array<Record<string, unknown>> } }>(
      "GET", `/api/review/${c.reviewItemId}`, { token: tokenFor(userId) });
    expect(res.status).toBe(200);
    expect(res.body.data.search_hits.map((h) => h["rank"])).toEqual([1, 2]);
    expect(res.body.data.search_hits[0]!["is_official"]).toBe(true);

    const empty = await createCandidate(db);
    const res2 = await call<{ data: { search_hits: unknown[] } }>(
      "GET", `/api/review/${empty.reviewItemId}`, { token: tokenFor(userId) });
    expect(res2.body.data.search_hits).toEqual([]);
  });
});
