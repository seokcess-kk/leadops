import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearerToken, JwtError, signJwt, verifyJwt } from "./jwt";

/**
 * JWT 검증.
 *
 * 라이브러리를 쓰지 않는 대신 **공격 케이스를 여기서 고정한다.** 이 파일이 통과하는 한
 * alg 혼동·서명 위조·만료 무시가 통과하지 못한다.
 */

const SECRET = "test-secret-0123456789";
const SUB = "11111111-2222-3333-4444-555555555555";
const NOW = 1_800_000_000_000; // ms
const future = (): number => Math.floor(NOW / 1000) + 3600;

const token = (claims: Record<string, unknown> = {}, secret = SECRET): string =>
  signJwt({ sub: SUB, exp: future(), ...claims }, secret);

const unsigned = (header: Record<string, unknown>, payload: Record<string, unknown>): [string, string] => [
  Buffer.from(JSON.stringify(header)).toString("base64url"),
  Buffer.from(JSON.stringify(payload)).toString("base64url"),
];

describe("정상 검증", () => {
  it("서명과 클레임이 맞으면 통과한다", () => {
    const claims = verifyJwt(token(), SECRET, NOW);
    expect(claims.sub).toBe(SUB);
    expect(claims.exp).toBe(future());
  });

  it("role·email 을 함께 돌려준다", () => {
    const claims = verifyJwt(token({ role: "authenticated", email: "a@b.kr" }), SECRET, NOW);
    expect(claims.role).toBe("authenticated");
    expect(claims.email).toBe("a@b.kr");
  });
});

describe("❗ alg 혼동 공격", () => {
  it("alg none 을 거부한다", () => {
    const [h, p] = unsigned({ alg: "none", typ: "JWT" }, { sub: SUB, exp: future() });
    expect(() => verifyJwt(`${h}.${p}.`, SECRET, NOW)).toThrow(/허용되지 않은 alg/);
  });

  it("alg 를 RS256 으로 바꿔치기해도 거부한다", () => {
    const [h, p] = unsigned({ alg: "RS256", typ: "JWT" }, { sub: SUB, exp: future() });
    const sig = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
    expect(() => verifyJwt(`${h}.${p}.${sig}`, SECRET, NOW)).toThrow(/허용되지 않은 alg/);
  });

  it("alg 를 소문자로 써도 거부한다", () => {
    const [h, p] = unsigned({ alg: "hs256" }, { sub: SUB, exp: future() });
    const sig = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
    expect(() => verifyJwt(`${h}.${p}.${sig}`, SECRET, NOW)).toThrow(/alg/);
  });
});

describe("❗ 서명 위조", () => {
  it("다른 비밀키로 서명한 토큰을 거부한다", () => {
    expect(() => verifyJwt(token({}, "other-secret"), SECRET, NOW)).toThrow(/서명/);
  });

  it("페이로드를 바꾸면 거부한다", () => {
    const parts = token().split(".");
    const [, tampered] = unsigned({}, { sub: SUB, exp: future(), role: "admin" });
    expect(() => verifyJwt(`${parts[0]}.${tampered}.${parts[2]}`, SECRET, NOW)).toThrow(/서명/);
  });

  it("서명을 잘라내면 거부한다", () => {
    const parts = token().split(".");
    expect(() => verifyJwt(`${parts[0]}.${parts[1]}.`, SECRET, NOW)).toThrow(JwtError);
  });

  it("서명 길이가 달라도 던지지 않고 거부한다 (timingSafeEqual 예외 방지)", () => {
    const parts = token().split(".");
    expect(() => verifyJwt(`${parts[0]}.${parts[1]}.AAAA`, SECRET, NOW)).toThrow(/서명이 일치하지 않습니다/);
  });
});

describe("❗ 시간 클레임", () => {
  it("만료된 토큰을 거부한다", () => {
    const expired = signJwt({ sub: SUB, exp: Math.floor(NOW / 1000) - 3600 }, SECRET);
    expect(() => verifyJwt(expired, SECRET, NOW)).toThrow(/만료/);
  });

  it("exp 가 없으면 거부한다", () => {
    expect(() => verifyJwt(signJwt({ sub: SUB }, SECRET), SECRET, NOW)).toThrow(/exp/);
  });

  it("시계 오차 30초는 허용한다", () => {
    const justExpired = signJwt({ sub: SUB, exp: Math.floor(NOW / 1000) - 10 }, SECRET);
    expect(() => verifyJwt(justExpired, SECRET, NOW)).not.toThrow();
  });

  it("nbf 가 미래면 거부한다", () => {
    const notYet = signJwt({ sub: SUB, exp: future(), nbf: Math.floor(NOW / 1000) + 600 }, SECRET);
    expect(() => verifyJwt(notYet, SECRET, NOW)).toThrow(/아직 유효하지/);
  });
});

describe("❗ sub 검증", () => {
  it("sub 가 UUID 가 아니면 거부한다 (RLS 의 auth.uid() 로 들어간다)", () => {
    expect(() => verifyJwt(token({ sub: "admin" }), SECRET, NOW)).toThrow(/UUID/);
    expect(() => verifyJwt(token({ sub: "" }), SECRET, NOW)).toThrow(/UUID/);
  });

  it("sub 가 없으면 거부한다", () => {
    expect(() => verifyJwt(signJwt({ exp: future() }, SECRET), SECRET, NOW)).toThrow(/UUID/);
  });
});

describe("형식", () => {
  it("점이 3개가 아니면 거부한다", () => {
    expect(() => verifyJwt("a.b", SECRET, NOW)).toThrow(/형식/);
    expect(() => verifyJwt("a.b.c.d", SECRET, NOW)).toThrow(/형식/);
  });

  it("비밀키가 없으면 거부한다", () => {
    expect(() => verifyJwt(token(), "", NOW)).toThrow(/비밀키/);
  });
});

describe("Bearer 헤더", () => {
  it("토큰을 꺼낸다", () => {
    const t = token();
    expect(bearerToken(`Bearer ${t}`)).toBe(t);
    expect(bearerToken(`bearer ${t}`)).toBe(t);
  });

  it("헤더가 없거나 형식이 다르면 거부한다", () => {
    expect(() => bearerToken(undefined)).toThrow(/Authorization/);
    expect(() => bearerToken("Basic abc")).toThrow(/Bearer/);
  });
});
