import { describe, expect, it } from "vitest";
import { checkSyntax, verifyEmailAddress, type MxResolver } from "./mx";

/**
 * 이메일 문법 · DNS · MX 검증.
 *
 * ❗ SMTP 접속은 하지 않는다 (설계서 1.6). 상대 서버에 붙어 수신자 존재를 떠보는
 *    프로빙은 이 모듈에 없다 — MX 레코드가 있는지까지만 본다.
 */

const resolver = (over: Partial<MxResolver> = {}): MxResolver => ({
  mx: async () => [],
  a: async () => [],
  aaaa: async () => [],
  ...over,
});

describe("문법", () => {
  it("정상 주소를 통과시킨다", () => {
    const r = checkSyntax("info@raon-derm.co.kr");
    expect(r.ok).toBe(true);
    expect(r.local).toBe("info");
    expect(r.domain).toBe("raon-derm.co.kr");
  });

  it("도메인을 소문자로 정규화한다", () => {
    expect(checkSyntax("A@Example.CO.KR").domain).toBe("example.co.kr");
  });

  it("❗ 거부해야 하는 형태", () => {
    const bad = [
      "",
      "   ",
      "noat",
      "@no-local.kr",
      "no-domain@",
      "a@b",
      "a@.b.kr",
      "a@b.kr.",
      "a@b..kr",
      "a b@c.kr",
      "a@b c.kr",
      "a@b@c.kr",
    ];
    for (const value of bad) expect(checkSyntax(value).ok, value).toBe(false);
  });

  it("길이 상한을 지킨다 (RFC 5321)", () => {
    expect(checkSyntax(`${"a".repeat(65)}@b.kr`).reason).toBe("local_too_long");
    expect(checkSyntax(`a@${"b".repeat(260)}.kr`).reason).toBe("too_long");
  });
});

describe("MX 판정", () => {
  it("MX 레코드가 있으면 통과하고 우선순위 순으로 정렬한다", async () => {
    const r = await verifyEmailAddress(
      "a@b.kr",
      resolver({
        mx: async () => [
          { exchange: "mx2.b.kr", priority: 20 },
          { exchange: "mx1.b.kr", priority: 10 },
        ],
      }),
    );
    expect(r.mxOk).toBe(true);
    expect(r.dnsOk).toBe(true);
    expect(r.implicitMx).toBe(false);
    expect(r.mxHosts).toEqual(["mx1.b.kr", "mx2.b.kr"]);
  });

  it("❗ null MX 는 메일을 받지 않겠다는 선언이다 (RFC 7505)", async () => {
    const r = await verifyEmailAddress("a@b.kr", resolver({ mx: async () => [{ exchange: ".", priority: 0 }] }));
    expect(r.mxOk).toBe(false);
    expect(r.reason).toBe("domain_not_resolvable");
  });

  it("MX 가 없고 A 가 있으면 implicit MX 로 통과한다 (RFC 5321)", async () => {
    const r = await verifyEmailAddress("a@b.kr", resolver({ a: async () => ["1.2.3.4"] }));
    expect(r.mxOk).toBe(true);
    expect(r.implicitMx).toBe(true);
    // 어느 경로로 통과했는지를 신뢰도로 구분한다.
    expect(r.confidence).toBeLessThan(0.9);
  });

  it("AAAA 만 있어도 통과한다", async () => {
    const r = await verifyEmailAddress("a@b.kr", resolver({ aaaa: async () => ["2001:db8::1"] }));
    expect(r.mxOk).toBe(true);
    expect(r.implicitMx).toBe(true);
  });

  it("아무것도 해석되지 않으면 실패한다", async () => {
    const r = await verifyEmailAddress("a@b.kr", resolver());
    expect(r.dnsOk).toBe(false);
    expect(r.mxOk).toBe(false);
    expect(r.reason).toBe("domain_not_resolvable");
  });

  it("DNS 조회가 던져도 결과로 처리한다 (파이프라인 오류가 아니다)", async () => {
    const boom = async (): Promise<never> => {
      throw new Error("ENOTFOUND");
    };
    const r = await verifyEmailAddress("a@b.kr", resolver({ mx: boom, a: boom, aaaa: boom }));
    expect(r.mxOk).toBe(false);
    expect(r.reason).toBe("domain_not_resolvable");
  });

  it("❗ 문법이 틀리면 DNS 를 조회하지 않는다", async () => {
    let called = 0;
    const r = await verifyEmailAddress(
      "not-an-address",
      resolver({
        mx: async () => {
          called++;
          return [];
        },
      }),
    );
    expect(r.syntaxOk).toBe(false);
    expect(called).toBe(0);
  });

  it("도메인을 결과에 남긴다", async () => {
    const r = await verifyEmailAddress("A@Example.KR", resolver({ a: async () => ["1.2.3.4"] }));
    expect(r.domain).toBe("example.kr");
  });
});
