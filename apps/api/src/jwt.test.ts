import { createHmac, generateKeyPairSync, sign as signWithKey } from "node:crypto";
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

// ── ES256 테스트 키 (Supabase JWT signing keys 와 같은 P-256) ──
const es256Pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ES256_JWK = JSON.stringify(es256Pair.publicKey.export({ format: "jwk" }));
const KEYS = { hs256Secret: SECRET, es256PublicJwk: ES256_JWK };

const es256Token = (claims: Record<string, unknown> = {}, privateKey = es256Pair.privateKey): string => {
  const [h, p] = unsigned({ alg: "ES256", typ: "JWT" }, { sub: SUB, exp: future(), ...claims });
  const sig = signWithKey("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${sig.toString("base64url")}`;
};

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

  it("검증 키가 하나도 없으면 거부한다", () => {
    expect(() => verifyJwt(token(), "", NOW)).toThrow(/검증 키/);
    expect(() => verifyJwt(token(), {}, NOW)).toThrow(/검증 키/);
  });
});

describe("ES256 (Supabase JWT signing keys)", () => {
  it("공개키로 서명이 검증되면 통과한다", () => {
    const claims = verifyJwt(es256Token({ role: "authenticated", email: "a@b.kr" }), KEYS, NOW);
    expect(claims.sub).toBe(SUB);
    expect(claims.role).toBe("authenticated");
  });

  it("❗ 다른 키로 서명한 ES256 토큰을 거부한다", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => verifyJwt(es256Token({}, other.privateKey), KEYS, NOW)).toThrow(/서명이 일치하지 않습니다/);
  });

  it("❗ 공개키가 설정되지 않았으면 ES256 토큰을 전부 거부한다 (fail-closed)", () => {
    expect(() => verifyJwt(es256Token(), { hs256Secret: SECRET }, NOW)).toThrow(/ES256 공개키가 설정되지/);
  });

  it("❗ alg 혼동 — 공개키 JSON 을 HMAC 키로 쓴 HS256 토큰은 dev 시크릿 검증에서 떨어진다", () => {
    // 고전적 혼동 공격: 공개키를 알아내 HMAC 시크릿으로 쓰는 경우. alg=HS256 은
    // 언제나 hs256Secret 으로만 검증하므로 공개키 서명은 통과할 수 없다.
    const forged = signJwt({ sub: SUB, exp: future() }, ES256_JWK);
    expect(() => verifyJwt(forged, KEYS, NOW)).toThrow(/서명이 일치하지 않습니다/);
  });

  it("서명을 DER 등 다른 인코딩으로 보내면 거부한다 (64바이트 raw R||S 만)", () => {
    const t = es256Token();
    const [h, p] = [t.split(".")[0]!, t.split(".")[1]!];
    const derSig = signWithKey("sha256", Buffer.from(`${h}.${p}`), { key: es256Pair.privateKey, dsaEncoding: "der" });
    expect(() => verifyJwt(`${h}.${p}.${derSig.toString("base64url")}`, KEYS, NOW)).toThrow(/서명이 일치하지 않습니다/);
  });

  it("P-256 이 아닌 곡선의 JWK 를 거부한다", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    const wrongCurve = JSON.stringify(p384.publicKey.export({ format: "jwk" }));
    expect(() => verifyJwt(es256Token(), { es256PublicJwk: wrongCurve }, NOW)).toThrow(/P-256/);
  });

  it("JWK 가 JSON 이 아니면 거부한다", () => {
    expect(() => verifyJwt(es256Token(), { es256PublicJwk: "not-json" }, NOW)).toThrow(/해석할 수 없습니다/);
  });

  it("만료·sub 검사는 ES256 에도 똑같이 적용된다", () => {
    const expired = es256Token({ exp: Math.floor(NOW / 1000) - 3600 });
    expect(() => verifyJwt(expired, KEYS, NOW)).toThrow(/만료/);
    expect(() => verifyJwt(es256Token({ sub: "admin" }), KEYS, NOW)).toThrow(/UUID/);
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
