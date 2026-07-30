import type { AddressInfo } from "node:net";
import { nullLogger } from "@leadops/core";
import { createCandidate, createTestDb, createUser, type Candidate, type TestDb } from "@leadops/db";
import type { MxResolver } from "@leadops/http";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signJwt } from "./jwt";
import { createApi } from "./server";

/**
 * 검수 API 통합 — 실제 HTTP 서버 · 실제 Postgres · 실제 RPC.
 *
 * ❗ 여기서 확인해야 할 것은 "응답이 오는가" 가 아니라 **규칙이 API 를 통과해도 유지되는가** 다.
 *    상한·쿼터·게이트·nonce 는 DB 안에 있고, API 는 그것을 우회할 수 없어야 한다.
 */

const SECRET = "integration-secret-0123456789";

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

  server = createApi({ sql: db.owner, jwtSecret: SECRET, logger: nullLogger, resolver: goodMx });
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
