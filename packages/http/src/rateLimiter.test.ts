import { describe, expect, it } from "vitest";
import { backoffDelayMs, isRetryableStatus, parseRetryAfter } from "./backoff";
import { RateLimiter, rateLimitKey } from "./rateLimiter";

/** 가상 시계. 실제로 기다리지 않고 sleep 을 시간 이동으로 대체한다. */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get value() {
      return now;
    },
  };
}

describe("RateLimiter — 도메인 간격", () => {
  it("같은 도메인 연속 요청 사이에 간격을 강제한다", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ perDomainIntervalMs: 2000, globalConcurrency: 8, now: clock.now, sleep: clock.sleep });

    (await rl.acquire("a.kr"))();
    expect(clock.value).toBe(0);

    (await rl.acquire("a.kr"))();
    expect(clock.value).toBe(2000);

    (await rl.acquire("a.kr"))();
    expect(clock.value).toBe(4000);
  });

  it("다른 도메인은 서로를 지연시키지 않는다", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ perDomainIntervalMs: 2000, globalConcurrency: 8, now: clock.now, sleep: clock.sleep });

    (await rl.acquire("a.kr"))();
    (await rl.acquire("b.kr"))();
    expect(clock.value).toBe(0);
  });

  it("충분히 시간이 지났으면 기다리지 않는다", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ perDomainIntervalMs: 2000, globalConcurrency: 8, now: clock.now, sleep: clock.sleep });

    (await rl.acquire("a.kr"))();
    clock.advance(5000);
    (await rl.acquire("a.kr"))();
    expect(clock.value).toBe(5000);
  });

  it("crawl-delay 가 기본 간격보다 크면 그것을 따른다", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ perDomainIntervalMs: 2000, globalConcurrency: 8, now: clock.now, sleep: clock.sleep });
    rl.setCrawlDelay("slow.kr", 10);
    expect(rl.intervalFor("slow.kr")).toBe(10_000);

    (await rl.acquire("slow.kr"))();
    (await rl.acquire("slow.kr"))();
    expect(clock.value).toBe(10_000);
  });

  it("crawl-delay 가 기본 간격보다 작으면 무시한다 (우리가 더 보수적)", () => {
    const rl = new RateLimiter({ perDomainIntervalMs: 2000, globalConcurrency: 8 });
    rl.setCrawlDelay("fast.kr", 0.5);
    expect(rl.intervalFor("fast.kr")).toBe(2000);
  });
});

describe("RateLimiter — 전역 동시성", () => {
  it("상한을 넘는 요청은 슬롯이 날 때까지 대기한다", async () => {
    const rl = new RateLimiter({ perDomainIntervalMs: 0, globalConcurrency: 2 });

    const r1 = await rl.acquire("a.kr");
    const r2 = await rl.acquire("b.kr");
    expect(rl.activeCount).toBe(2);

    let third = false;
    const p3 = rl.acquire("c.kr").then((rel) => {
      third = true;
      return rel;
    });

    await Promise.resolve();
    expect(third).toBe(false); // 아직 대기 중

    r1();
    const r3 = await p3;
    expect(third).toBe(true);

    r2();
    r3();
    expect(rl.activeCount).toBe(0);
  });

  it("release 를 두 번 불러도 카운트가 깨지지 않는다", async () => {
    const rl = new RateLimiter({ perDomainIntervalMs: 0, globalConcurrency: 1 });
    const rel = await rl.acquire("a.kr");
    rel();
    rel();
    expect(rl.activeCount).toBe(0);
  });

  it("❗ 대기자가 깨어나기 직전에 새 요청이 끼어들어도 상한을 넘지 않는다", async () => {
    // 재현 조건이 까다로우므로 마이크로태스크 순서를 손으로 만든다.
    //
    // 버그가 있던 구현: release 가 #active-- 를 먼저 하고 대기자를 깨운다.
    //   → 대기자의 continuation(#active++)이 실행되기 **전에** 새 acquire 가
    //     동기적으로 빈 슬롯을 보고 차지한다 → 깨어난 대기자가 상한을 넘긴다.
    //
    // 고친 구현: release 는 대기자가 있으면 #active 를 건드리지 않고 슬롯을 양도한다.
    const cap = 2;
    const rl = new RateLimiter({ perDomainIntervalMs: 0, globalConcurrency: cap });

    const r1 = await rl.acquire("a.kr");
    const r2 = await rl.acquire("b.kr");
    expect(rl.activeCount).toBe(2);

    const pending = rl.acquire("c.kr"); // 대기열에 들어간다
    await Promise.resolve();
    expect(rl.activeCount).toBe(2);

    r1(); // 슬롯 반납 — 대기자 resolve 는 마이크로태스크로 예약된다
    const intruder = rl.acquire("d.kr"); // ❗ 그 continuation 이 돌기 전에 동기적으로 진입 시도

    const r3 = await pending;
    expect(rl.activeCount).toBeLessThanOrEqual(cap);

    r2();
    const r4 = await intruder;
    expect(rl.activeCount).toBeLessThanOrEqual(cap);

    r3();
    r4();
    expect(rl.activeCount).toBe(0);
  });

  it("모든 요청이 완료되면 activeCount 가 정확히 0 으로 돌아온다", async () => {
    const rl = new RateLimiter({ perDomainIntervalMs: 0, globalConcurrency: 3 });
    const releases = await Promise.all(Array.from({ length: 3 }, (_, i) => rl.acquire(`d${i}.kr`)));
    expect(rl.activeCount).toBe(3);
    for (const r of releases) r();
    expect(rl.activeCount).toBe(0);
  });
});

describe("backoffDelayMs", () => {
  it("지수적으로 증가한다", () => {
    const opts = { baseMs: 2000, jitterRatio: 0, random: () => 0 };
    expect(backoffDelayMs(0, opts)).toBe(2000);
    expect(backoffDelayMs(1, opts)).toBe(4000);
    expect(backoffDelayMs(2, opts)).toBe(8000);
  });

  it("cap 을 넘지 않는다", () => {
    expect(backoffDelayMs(20, { baseMs: 2000, capMs: 300_000, jitterRatio: 0, random: () => 0 })).toBe(300_000);
  });

  it("jitter 를 더한다", () => {
    expect(backoffDelayMs(0, { baseMs: 2000, jitterRatio: 0.25, random: () => 1 })).toBe(2500);
    expect(backoffDelayMs(0, { baseMs: 2000, jitterRatio: 0.25, random: () => 0.5 })).toBe(2250);
  });

  it("음수 시도 횟수를 거부한다", () => {
    expect(() => backoffDelayMs(-1)).toThrow();
  });
});

describe("isRetryableStatus", () => {
  it.each([408, 425, 429, 500, 502, 503, 504])("%d 는 재시도한다", (s) => {
    expect(isRetryableStatus(s)).toBe(true);
  });
  it.each([200, 301, 400, 401, 403, 404, 410, 451, 501])("%d 는 재시도하지 않는다", (s) => {
    expect(isRetryableStatus(s)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-07-29T00:00:00Z");
  it("초 단위 정수를 ms 로 바꾼다", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
  });
  it("HTTP-date 를 남은 시간으로 바꾼다", () => {
    expect(parseRetryAfter("Wed, 29 Jul 2026 00:01:00 GMT", now)).toBe(60_000);
  });
  it("이미 지난 날짜는 0 으로 만든다", () => {
    expect(parseRetryAfter("Tue, 28 Jul 2026 00:00:00 GMT", now)).toBe(0);
  });
  it("해석 불가·미지정은 undefined", () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter("나중에", now)).toBeUndefined();
  });
});

describe("rateLimitKey", () => {
  it("호스트명을 소문자로 정규화한다", () => {
    expect(rateLimitKey(new URL("https://Example.KR/a"))).toBe("example.kr");
  });
});
