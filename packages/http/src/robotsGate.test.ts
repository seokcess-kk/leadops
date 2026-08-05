import { describe, expect, it } from "vitest";
import type { FetchResult, HttpClient } from "./client";
import { RobotsGate, userAgentToken } from "./robotsGate";

/**
 * robots.txt 게이트.
 *
 * 핵심 원칙은 **fail-closed** 다. robots.txt 를 판단할 수 없으면 가지 않는다.
 * 404 만 예외다 — 파일이 없는 것은 "제한 없음" 이라는 표준 동작이기 때문이다.
 */

interface Call {
  url: string;
}

function fakeClient(
  respond: (url: string) => Promise<Partial<FetchResult>> | Partial<FetchResult>,
): { client: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async get(url: string): Promise<FetchResult> {
      calls.push({ url });
      const partial = await respond(url);
      return {
        status: 200,
        finalUrl: url,
        headers: {},
        body: "",
        hops: [],
        truncated: false,
        ...partial,
      };
    },
  } as unknown as HttpClient;
  return { client, calls };
}

const gateWith = (
  respond: Parameters<typeof fakeClient>[0],
  options: { ttlMs?: number; now?: () => number } = {},
) => {
  const { client, calls } = fakeClient(respond);
  return {
    calls,
    gate: new RobotsGate({ client, userAgentToken: "leadopsbot", ...options }),
  };
};

describe("UA 토큰", () => {
  it("제품 토큰만 뽑는다", () => {
    expect(userAgentToken("LeadOpsBot/1.0 (+https://example.kr/bot)")).toBe("leadopsbot");
    expect(userAgentToken("SomeBot")).toBe("somebot");
  });
});

describe("정상 판정", () => {
  it("Disallow 규칙을 지킨다", async () => {
    const { gate } = gateWith(() => ({ body: "User-agent: *\nDisallow: /admin\n" }));
    expect((await gate.check("https://a.kr/admin/x")).allowed).toBe(false);
    expect((await gate.check("https://a.kr/")).allowed).toBe(true);
  });

  it("우리 UA 전용 그룹을 우선 적용한다", async () => {
    const { gate } = gateWith(() => ({
      body: "User-agent: *\nDisallow: /\n\nUser-agent: LeadOpsBot\nDisallow:\n",
    }));
    expect((await gate.check("https://a.kr/any")).allowed).toBe(true);
  });

  it("Crawl-delay 를 전달한다", async () => {
    const { gate } = gateWith(() => ({
      body: "User-agent: LeadOpsBot\nCrawl-delay: 5\nDisallow: /x\n",
    }));
    expect((await gate.check("https://a.kr/")).crawlDelaySec).toBe(5);
  });
});

describe("❗ fail-closed", () => {
  it("404 는 전면 허용이다 (robots.txt 가 없는 것)", async () => {
    const decision = await gateWith(() => ({ status: 404 })).gate.check("https://a.kr/x");
    expect(decision.allowed).toBe(true);
    expect(decision.failure).toBe("not_found");
  });

  it("5xx 면 막는다", async () => {
    const decision = await gateWith(() => ({ status: 503 })).gate.check("https://a.kr/x");
    expect(decision.allowed).toBe(false);
    expect(decision.failure).toBe("fetch_error");
  });

  it("❗ 4xx(401·403)는 허용한다 — RFC 9309 unavailable (D-005)", async () => {
    // 실측(골드셋 FN): 사람은 열리는 사이트의 robots.txt 가 403 을 줬다. RFC 9309
    // §2.3.1.3 은 400-499 를 "unavailable" 로 보고 접근 가능으로 다룰 수 있다고 하고,
    // Google 도 같게 동작한다. 5xx·네트워크 실패는 그대로 fail-closed 다.
    const forbidden = await gateWith(() => ({ status: 403 })).gate.check("https://a.kr/x");
    expect(forbidden.allowed).toBe(true);
    expect(forbidden.failure).toBe("unavailable_4xx");
    const unauthorized = await gateWith(() => ({ status: 401 })).gate.check("https://a.kr/x");
    expect(unauthorized.allowed).toBe(true);
  });

  it("네트워크 오류면 막는다", async () => {
    const { gate } = gateWith(() => {
      throw new Error("ECONNREFUSED");
    });
    const decision = await gate.check("https://a.kr/x");
    expect(decision.allowed).toBe(false);
    expect(decision.failure).toBe("fetch_error");
  });

  it("본문이 잘렸으면 막는다 (뒷부분에 우리를 막는 규칙이 있었을 수 있다)", async () => {
    const { gate } = gateWith(() => ({ body: "User-agent: *\nDisallow: /a\n", truncated: true }));
    const decision = await gate.check("https://a.kr/anything");
    expect(decision.allowed).toBe(false);
    expect(decision.failure).toBe("too_large");
  });

  it("URL 이 잘못되면 막는다", async () => {
    expect((await gateWith(() => ({})).gate.check("not-a-url")).allowed).toBe(false);
  });
});

describe("캐시", () => {
  it("같은 오리진은 한 번만 받는다", async () => {
    const { gate, calls } = gateWith(() => ({ body: "User-agent: *\nDisallow: /x\n" }));
    await gate.check("https://a.kr/1");
    await gate.check("https://a.kr/2");
    await gate.check("https://a.kr/3");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://a.kr/robots.txt");
  });

  it("오리진이 다르면 따로 받는다 (스킴·포트 포함)", async () => {
    const { gate, calls } = gateWith(() => ({ body: "" }));
    await gate.check("https://a.kr/1");
    await gate.check("http://a.kr/1");
    await gate.check("https://b.kr/1");
    await gate.check("https://a.kr:8443/1");
    expect(calls.length).toBe(4);
  });

  it("❗ 동시에 들어온 요청이 robots.txt 를 여러 번 받지 않는다", async () => {
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const { gate, calls } = gateWith(async () => {
      await blocker;
      return { body: "User-agent: *\nDisallow: /x\n" };
    });

    const pending = [gate.check("https://a.kr/1"), gate.check("https://a.kr/2"), gate.check("https://a.kr/3")];
    release!();
    const decisions = await Promise.all(pending);

    expect(calls.length).toBe(1);
    expect(decisions.every((d) => d.allowed)).toBe(true);
  });

  it("TTL 이 지나면 다시 받는다", async () => {
    let clock = 1_000;
    const { gate, calls } = gateWith(() => ({ body: "" }), { ttlMs: 1_000, now: () => clock });
    await gate.check("https://a.kr/1");
    clock += 500;
    await gate.check("https://a.kr/2");
    expect(calls.length).toBe(1);
    clock += 600;
    await gate.check("https://a.kr/3");
    expect(calls.length).toBe(2);
  });

  it("실패도 캐시한다 (같은 도메인을 반복해 두드리지 않는다)", async () => {
    const { gate, calls } = gateWith(() => ({ status: 500 }));
    await gate.check("https://a.kr/1");
    await gate.check("https://a.kr/2");
    expect(calls.length).toBe(1);
  });
});
