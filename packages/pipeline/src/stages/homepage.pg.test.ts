import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { nullLogger } from "@leadops/core";
import { createRun, createTestDb, relativeDate, type TestDb } from "@leadops/db";
import { HttpClient, loopbackPolicyForTests, RobotsGate, type DnsResolver } from "@leadops/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactPagesStage } from "./contactPages";
import { homepageStage } from "./homepage";
import type { StageContext } from "./types";

/**
 * Phase 3 통합 — 실제 HTTP 서버 · 실제 Postgres.
 *
 * 가짜 fetch 로 통과시키면 검증한 것이 아니다. 로컬에 진짜 서버를 띄우고
 * DNS 리졸버로 가짜 호스트명을 loopback 에 붙여, robots.txt 조회부터
 * redirect·판정·저장까지 전 경로를 그대로 통과시킨다.
 */

const FULL_HTML = `
<html><head>
  <title>라온피부과의원 | 강남 피부과</title>
  <meta property="og:site_name" content="라온피부과의원">
</head><body>
  <nav><a href="/">홈</a><a href="/doctors">의료진</a><a href="/price">비용안내</a></nav>
  <p>서울특별시 강남구 테헤란로 1길 10</p>
  <p>대표전화 02-1234-5678</p>
  <a href="/contact">오시는 길</a>
  <a href="/about">병원소개</a>
  <a href="/privacy">개인정보처리방침</a>
  <a href="mailto:info@raon-derm.test">이메일 문의</a>
  <p>진료시간 안내와 의료진 프로필을 확인하실 수 있습니다. 편안한 진료 환경을 준비했습니다.</p>
</body></html>`;

interface Site {
  robots?: string;
  robotsStatus?: number;
  html?: string;
  /** 경로별 페이지. 없으면 모든 경로가 `html` 을 받는다. */
  pages?: Record<string, string>;
}

const SITES: Record<string, Site> = {
  "raon-derm.test": { robots: "User-agent: *\nAllow: /\n", html: FULL_HTML },
  // robots 가 전면 금지 → 가져오지 않는다
  "blocked.test": { robots: "User-agent: *\nDisallow: /\n", html: FULL_HTML },
  // robots 조회 실패 → fail-closed
  "broken.test": { robotsStatus: 503, html: FULL_HTML },
  // robots 없음(404) → 전면 허용. 내용은 껍데기
  "shell.test": { robotsStatus: 404, html: `<html><head><title>준비중</title></head><body>준비중</body></html>` },
  // 애그리게이터 도메인 — 가져올 수는 있어도 공식 홈페이지가 아니다
  "place.naver.com": { robotsStatus: 404, html: FULL_HTML },
  // Crawl-delay 가 상한(30s)을 훨씬 넘는다 — 실측: 600·3600 이 판정을 통째로 막았다
  "slowcrawl.test": { robots: "User-agent: *\nAllow: /\nCrawl-delay: 3600\n", html: FULL_HTML },
  // JS 리다이렉트 껍데기 — 홈은 이동 스크립트뿐이고 실내용은 /index.php 에 있다 (골드셋 FN 실사례)
  "jsshell.test": {
    robotsStatus: 404,
    html: `<html><head><title>이동중</title><script>
      if (navigator.userAgent.match(/iPhone|Android/) != null) {
        location.href = "/m/";
      } else {
        location.href = "/index.php";
      }
    </script></head></html>`,
    pages: { "/index.php": FULL_HTML },
  },
  // 다른 출처로의 이동은 따라가지 않는다
  "crossshell.test": {
    robotsStatus: 404,
    html: `<html><head><title>이동중</title><script>location.href = "http://raon-derm.test/";</script></head></html>`,
  },
  // 공식이지만 연락처 페이지 링크가 없다
  "nolink.test": {
    robotsStatus: 404,
    html: `<html><head><title>맑은치과의원</title></head><body>
      <nav><a href="/">홈</a><a href="/notice">공지</a><a href="/price">비용</a>
           <a href="/doctors">의료진</a><a href="/gallery">둘러보기</a></nav>
      <p>부산광역시 해운대구</p><p>051-777-8888</p>
      <p>진료 안내입니다. 편안하게 모시겠습니다.</p></body></html>`,
  },
};

let db: TestDb;
let server: Server;
let port: number;

const hostOf = (req: { headers: { host?: string | undefined } }): string =>
  (req.headers.host ?? "").split(":")[0]!.toLowerCase();

beforeAll(async () => {
  db = await createTestDb("homepage");

  server = createServer((req, res) => {
    const site = SITES[hostOf(req)];
    if (!site) {
      res.writeHead(404).end("no such site");
      return;
    }
    if (req.url === "/robots.txt") {
      if (site.robotsStatus && site.robotsStatus !== 200) {
        res.writeHead(site.robotsStatus, { "content-type": "text/plain" }).end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end(site.robots ?? "");
      return;
    }
    const page = site.pages?.[req.url ?? ""];
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page ?? site.html ?? "");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db?.close();
});

/** 모든 호스트명을 loopback 으로 보낸다. SSRF 검증 경로는 그대로 탄다. */
const resolver: DnsResolver = async () => [{ address: "127.0.0.1", family: 4 }];

function makeContext(runId: string, attemptId: string, runDate: string): StageContext {
  const http = new HttpClient({
    userAgent: "LeadOpsBot/1.0 (+https://example.kr/bot)",
    perDomainIntervalMs: 0,
    globalConcurrency: 4,
    connectTimeoutMs: 2_000,
    totalTimeoutMs: 8_000,
    maxRetries: 0,
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 2,
    logger: nullLogger,
    resolver,
    ssrfPolicy: loopbackPolicyForTests(),
  });
  return {
    sql: db.owner,
    runId,
    attemptId,
    runDate,
    settings: {},
    logger: nullLogger,
    adapters: [],
    http,
    robots: new RobotsGate({ client: http, userAgentToken: "leadopsbot", logger: nullLogger }),
  };
}

interface Seeded {
  companyId: string;
  websiteId: string | null;
}

async function seed(
  attemptId: string,
  runDate: string,
  spec: { name: string; host: string | null; phone?: string; sigungu?: string; industry?: string },
): Promise<Seeded> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const [company] = await db.owner<{ id: string }[]>`
    insert into companies (dedupe_key, name, normalized_name, industry, region_sido, region_sigungu, phone)
    values (${`dk-${suffix}`}, ${spec.name}, ${spec.name}, ${spec.industry ?? "derm"},
            '서울특별시', ${spec.sigungu ?? null}, ${spec.phone ?? null})
    returning id
  `;
  const companyId = company!.id;

  await db.owner`
    insert into company_observations (company_id, attempt_id, run_date, status, track)
    values (${companyId}, ${attemptId}, ${runDate}::date, 'active', 'new')
  `;

  if (spec.host === null) return { companyId, websiteId: null };

  // ❗ canonicalizeUrl 은 포트를 떨어뜨리므로(운영에서는 80·443 만 허용) 여기서는 직접 넣는다.
  const [site] = await db.owner<{ id: string }[]>`
    insert into websites (company_id, canonical_url, domain)
    values (${companyId}, ${`http://${spec.host}:${port}/`}, ${spec.host})
    returning id
  `;
  return { companyId, websiteId: site!.id };
}

describe("homepage_detect — 공식 홈페이지 판별", () => {
  let attemptId: string;
  let runId: string;
  let runDate: string;
  const ids: Record<string, Seeded> = {};

  beforeAll(async () => {
    const run = await createRun(db, relativeDate(1));
    runId = run.runId;
    attemptId = run.attemptId;
    runDate = run.runDate;

    ids["official"] = await seed(attemptId, runDate, {
      name: "라온피부과의원", host: "raon-derm.test", phone: "0212345678", sigungu: "강남구",
    });
    ids["blocked"] = await seed(attemptId, runDate, { name: "차단의원", host: "blocked.test" });
    ids["broken"] = await seed(attemptId, runDate, { name: "고장의원", host: "broken.test" });
    ids["shell"] = await seed(attemptId, runDate, { name: "껍데기의원", host: "shell.test" });
    ids["aggregator"] = await seed(attemptId, runDate, { name: "플레이스의원", host: "place.naver.com" });
    ids["nolink"] = await seed(attemptId, runDate, {
      name: "맑은치과의원", host: "nolink.test", phone: "0517778888", sigungu: "해운대구", industry: "dental",
    });
    ids["nosite"] = await seed(attemptId, runDate, { name: "홈페이지없는의원", host: null });
    ids["slowcrawl"] = await seed(attemptId, runDate, {
      name: "라온피부과의원", host: "slowcrawl.test", phone: "0212345678", sigungu: "강남구",
    });
    ids["jsshell"] = await seed(attemptId, runDate, {
      name: "라온피부과의원", host: "jsshell.test", phone: "0212345678", sigungu: "강남구",
    });
    ids["crossshell"] = await seed(attemptId, runDate, { name: "교차셸의원", host: "crossshell.test" });

    const result = await homepageStage.run(makeContext(runId, attemptId, runDate), {});
    expect(result.processed).toBe(9);
  }, 60_000);

  const observationOf = async (key: string) => {
    const [row] = await db.owner<
      Array<{ official_status: string; official_score: string; signals: Record<string, unknown>;
              robots_allowed: boolean | null; http_status: number | null; crawled_pages: number;
              content_hash: string | null; has_contact_form_only: boolean }>
    >`
      select official_status, official_score, signals, robots_allowed, http_status,
             crawled_pages, content_hash, has_contact_form_only
      from website_observations
      where website_id = ${ids[key]!.websiteId!} and attempt_id = ${attemptId}
    `;
    return row!;
  };

  it("❗ 신호가 맞는 사이트를 confirmed 로 판정한다", async () => {
    const row = await observationOf("official");
    expect(row.official_status).toBe("confirmed");
    expect(Number(row.official_score)).toBeGreaterThanOrEqual(65);
    expect(row.signals["phoneMatch"]).toBe(true);
    expect(row.signals["regionMatch"]).toBe(true);
    expect(row.robots_allowed).toBe(true);
    expect(row.http_status).toBe(200);
    expect(row.crawled_pages).toBe(1);
    expect(row.content_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("❗ robots.txt 가 막으면 가져오지 않고 unavailable 로 남긴다", async () => {
    const row = await observationOf("blocked");
    expect(row.official_status).toBe("unavailable");
    expect(row.robots_allowed).toBe(false);
    expect(row.http_status).toBeNull();
    expect(row.crawled_pages).toBe(0);
    expect(row.signals["reason"]).toBe("robots_disallowed");
  });

  it("❗ robots.txt 조회에 실패하면 fail-closed 다", async () => {
    const row = await observationOf("broken");
    expect(row.official_status).toBe("unavailable");
    expect(row.robots_allowed).toBe(false);
    expect(row.signals["reason"]).toBe("robots_fetch_error");
  });

  it("❗ Crawl-delay 가 상한을 넘어도 포기하지 않는다 — 단일 요청은 위반할 간격이 없다", async () => {
    // Crawl-delay 는 연속 요청의 간격이다. 이 스테이지는 이 호스트에 콘텐츠 요청을
    // 한 번만 보내므로, 아무리 긴 delay 도 위반할 간격 자체가 생기지 않는다.
    const row = await observationOf("slowcrawl");
    expect(row.official_status).toBe("confirmed");
    expect(row.robots_allowed).toBe(true);
    expect(row.http_status).toBe(200);
    expect(row.crawled_pages).toBe(1);
  });

  it("❗ JS 리다이렉트 껍데기는 같은 출처 목적지를 한 번 따라가 판정한다", async () => {
    // 홈이 이동 스크립트뿐이면 껍데기를 채점하는 것이 아니라 실내용을 봐야 한다.
    const row = await observationOf("jsshell");
    expect(row.official_status).toBe("confirmed");
    expect(row.crawled_pages).toBe(2);
    expect(row.signals["phoneMatch"]).toBe(true);
  });

  it("❗ 다른 출처로의 이동은 따라가지 않는다", async () => {
    const row = await observationOf("crossshell");
    expect(row.official_status).toBe("uncertain");
    expect(row.crawled_pages).toBe(1);
  });

  it("robots.txt 가 404 면 가져온다 (표준 동작)", async () => {
    const row = await observationOf("shell");
    expect(row.robots_allowed).toBe(true);
    expect(row.http_status).toBe(200);
    expect(row.official_status).toBe("uncertain");
  });

  it("❗ 애그리게이터 도메인은 가져와도 not_official 이다", async () => {
    const row = await observationOf("aggregator");
    expect(row.official_status).toBe("not_official");
    expect(row.signals["disqualified"]).toBe("aggregator");
  });

  it("홈페이지 URL 이 없는 업체를 조용히 넘기지 않는다", async () => {
    // 관측을 남길 website 행이 없으므로 스테이지 결과의 skipped 로만 드러난다.
    const result = await homepageStage.run(makeContext(runId, attemptId, runDate), {});
    expect(result.skipped["no_homepage_url"]).toBe(1);
    expect(ids["nosite"]!.websiteId).toBeNull();
  });
});

describe("연락처 페이지 후보", () => {
  let attemptId: string;
  let runId: string;
  let runDate: string;
  let official: Seeded;
  let nolink: Seeded;
  let blocked: Seeded;

  beforeAll(async () => {
    const run = await createRun(db, relativeDate(2));
    runId = run.runId;
    attemptId = run.attemptId;
    runDate = run.runDate;
    official = await seed(attemptId, runDate, {
      name: "라온피부과의원", host: "raon-derm.test", phone: "0212345678", sigungu: "강남구",
    });
    nolink = await seed(attemptId, runDate, {
      name: "맑은치과의원", host: "nolink.test", phone: "0517778888", sigungu: "해운대구", industry: "dental",
    });
    blocked = await seed(attemptId, runDate, { name: "차단의원", host: "blocked.test" });
    await homepageStage.run(makeContext(runId, attemptId, runDate), {});
  }, 60_000);

  const pagesOf = async (websiteId: string) =>
    db.owner<Array<{ url: string; page_kind: string; link_text: string; confidence: string; body_fetched: boolean }>>`
      select url, page_kind, link_text, confidence, body_fetched
      from contact_pages where website_id = ${websiteId} and attempt_id = ${attemptId}
      order by confidence desc, url
    `;

  it("링크만 보고 후보를 기록한다", async () => {
    const pages = await pagesOf(official.websiteId!);
    const kinds = pages.map((p) => p.page_kind);
    expect(kinds).toContain("contact");
    expect(kinds).toContain("about");
    expect(kinds).toContain("privacy");
  });

  it("❗ mailto: 링크는 후보가 되지 않는다 (제50조의2)", async () => {
    const pages = await pagesOf(official.websiteId!);
    for (const p of pages) expect(p.url).not.toContain("@");
    expect(pages.some((p) => p.url.startsWith("mailto"))).toBe(false);
  });

  it("❗ 후보 페이지의 본문은 가져오지 않았다", async () => {
    const pages = await pagesOf(official.websiteId!);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p.body_fetched).toBe(false);
  });

  it("공식이 아닌 사이트에는 후보를 남기지 않는다", async () => {
    expect(await pagesOf(blocked.websiteId!)).toEqual([]);
  });

  it("연락처 링크가 없는 사이트는 후보가 0건이다", async () => {
    expect(await pagesOf(nolink.websiteId!)).toEqual([]);
  });

  describe("contact_pages 스테이지 — 게이트와 집계", () => {
    it("커버리지를 집계한다", async () => {
      const result = await contactPagesStage.run(makeContext(runId, attemptId, runDate), {});
      // 공식(confirmed·likely) 2곳 중 1곳에서만 후보를 확보했다.
      expect(result.processed).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.skipped["no_contact_page"]).toBe(1);
      expect(result.note).toContain("커버리지 50%");
    });

    it("❗ 판정이 뒤집히면 남아 있던 후보를 회수한다", async () => {
      await db.owner`
        update website_observations set official_status = 'not_official'
        where website_id = ${official.websiteId!} and attempt_id = ${attemptId}
      `;
      const result = await contactPagesStage.run(makeContext(runId, attemptId, runDate), {});
      expect(result.skipped["revoked_not_official"]).toBeGreaterThan(0);
      expect(await pagesOf(official.websiteId!)).toEqual([]);
    });
  });
});

describe("❗ DNS 하이재킹 방어 — 여러 도메인이 같은 본문을 준다", () => {
  it("같은 content_hash 가 3곳 이상이면 전부 not_official 로 강등한다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(5));
    // 서로 다른 도메인이지만 같은 서버(같은 HTML)를 가리키는 상황을 만든다.
    // 국내 ISP 의 NXDOMAIN 하이재킹이 정확히 이 모양이다.
    const sites = [];
    for (let i = 0; i < 3; i++) {
      SITES[`hijack${i}.test`] = SITES["raon-derm.test"]!;
      sites.push(await seed(attemptId, runDate, {
        name: "라온피부과의원", host: `hijack${i}.test`, phone: "0212345678", sigungu: "강남구",
      }));
    }

    await homepageStage.run(makeContext(runId, attemptId, runDate), {});

    const before = await db.owner<Array<{ official_status: string }>>`
      select official_status from website_observations where attempt_id = ${attemptId}
    `;
    expect(before.every((r) => r.official_status === "confirmed")).toBe(true);

    const result = await contactPagesStage.run(makeContext(runId, attemptId, runDate), {});
    expect(result.skipped["shared_content"]).toBe(3);

    const after = await db.owner<Array<{ official_status: string; signals: Record<string, unknown> }>>`
      select official_status, signals from website_observations where attempt_id = ${attemptId}
    `;
    expect(after.every((r) => r.official_status === "not_official")).toBe(true);
    expect(after[0]!.signals["disqualified"]).toBe("shared_content");

    // 강등됐으므로 연락처 후보도 남지 않는다.
    const [pages] = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from contact_pages where attempt_id = ${attemptId}
    `;
    expect(pages!.n).toBe("0");
    expect(sites.length).toBe(3);
  }, 60_000);

  it("같은 본문이 2곳뿐이면 강등하지 않는다 (한 업체의 도메인 두 개는 정상)", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(6));
    for (let i = 0; i < 2; i++) {
      SITES[`twin${i}.test`] = SITES["raon-derm.test"]!;
      await seed(attemptId, runDate, {
        name: "라온피부과의원", host: `twin${i}.test`, phone: "0212345678", sigungu: "강남구",
      });
    }
    await homepageStage.run(makeContext(runId, attemptId, runDate), {});
    const result = await contactPagesStage.run(makeContext(runId, attemptId, runDate), {});
    expect(result.skipped["shared_content"]).toBeUndefined();

    const rows = await db.owner<Array<{ official_status: string }>>`
      select official_status from website_observations where attempt_id = ${attemptId}
    `;
    expect(rows.every((r) => r.official_status === "confirmed")).toBe(true);
  }, 60_000);
});

describe("멱등성", () => {
  it("같은 attempt 를 다시 처리해도 관측이 늘지 않는다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(3));
    const site = await seed(attemptId, runDate, {
      name: "라온피부과의원", host: "raon-derm.test", phone: "0212345678", sigungu: "강남구",
    });

    const first = await homepageStage.run(makeContext(runId, attemptId, runDate), {});
    expect(first.processed).toBe(1);

    // 두 번째 실행은 이미 관측이 있으므로 아무것도 처리하지 않는다.
    const second = await homepageStage.run(makeContext(runId, attemptId, runDate), {});
    expect(second.processed).toBe(0);

    const [row] = await db.owner<Array<{ n: string }>>`
      select count(*)::text as n from website_observations
      where website_id = ${site.websiteId!} and attempt_id = ${attemptId}
    `;
    expect(row!.n).toBe("1");
  }, 60_000);
});

describe("❗ 설정 누락은 조용히 넘어가지 않는다", () => {
  it("HttpClient 없이 실행하면 configuration_error 로 실패한다", async () => {
    const { runId, attemptId, runDate } = await createRun(db, relativeDate(4));
    const ctx: StageContext = {
      sql: db.owner, runId, attemptId, runDate, settings: {}, logger: nullLogger, adapters: [],
    };
    await expect(homepageStage.run(ctx, {})).rejects.toThrow(/HttpClient/);
  });
});
