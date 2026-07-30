import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HmacError, REPLAY_WINDOW_SEC, signInternal, verifyInternalSignature } from "./hmac";

/**
 * 내부 트리거 서명 — **공격 케이스를 테스트로 고정한다.**
 *
 * 이 경로는 JWT 없이 실행을 만들 수 있으므로, 뚫리면 누구나 파이프라인을 돌려 쿼터와
 * 비용을 소진시킬 수 있다. `jwt.test.ts` 와 같은 방식으로 우회 시도를 전부 적어 둔다.
 */

const SECRET = "internal-trigger-secret-at-least-32-chars";
const BODY = JSON.stringify({ industries: ["derm"] });
const NOW = 1_800_000_000;

const headers = (timestamp: number, signature: string) => ({
  timestamp: String(timestamp),
  signature,
});

const valid = () => headers(NOW, signInternal(SECRET, NOW, BODY));

const expectRejected = (fn: () => void, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HmacError);
    expect((err as HmacError).code).toBe(code);
    return;
  }
  throw new Error(`거부되어야 하는데 통과했습니다 (기대 코드: ${code})`);
};

describe("verifyInternalSignature", () => {
  it("올바른 서명은 통과한다", () => {
    expect(() => verifyInternalSignature(SECRET, valid(), BODY, NOW)).not.toThrow();
  });

  it("허용 창 경계 안이면 통과한다", () => {
    const t = NOW - REPLAY_WINDOW_SEC;
    expect(() =>
      verifyInternalSignature(SECRET, headers(t, signInternal(SECRET, t, BODY)), BODY, NOW),
    ).not.toThrow();
  });

  // ── 비밀 구성 ──

  it("❗ 비밀이 없으면 통과시키지 않는다 (무인증 트리거 방지)", () => {
    expectRejected(() => verifyInternalSignature(undefined, valid(), BODY, NOW), "trigger_unavailable");
    expectRejected(() => verifyInternalSignature("", valid(), BODY, NOW), "trigger_unavailable");
  });

  it("❗ 짧은 비밀은 거부한다", () => {
    const weak = "short";
    expectRejected(
      () => verifyInternalSignature(weak, headers(NOW, signInternal(weak, NOW, BODY)), BODY, NOW),
      "trigger_unavailable",
    );
  });

  // ── 재생 공격 ──

  it("❗ 오래된 서명은 거부한다 (재생 공격)", () => {
    const t = NOW - REPLAY_WINDOW_SEC - 1;
    expectRejected(
      () => verifyInternalSignature(SECRET, headers(t, signInternal(SECRET, t, BODY)), BODY, NOW),
      "stale_signature",
    );
  });

  it("❗ 미래 시각도 같은 창으로 거부한다 (시계를 앞당긴 서명)", () => {
    const t = NOW + REPLAY_WINDOW_SEC + 1;
    expectRejected(
      () => verifyInternalSignature(SECRET, headers(t, signInternal(SECRET, t, BODY)), BODY, NOW),
      "stale_signature",
    );
  });

  it("❗ 타임스탬프를 바꾸면 서명이 깨진다 (본문만 서명하지 않는다)", () => {
    const signed = signInternal(SECRET, NOW, BODY);
    expectRejected(
      () => verifyInternalSignature(SECRET, headers(NOW + 1, signed), BODY, NOW),
      "bad_signature",
    );
  });

  it("타임스탬프가 정수가 아니면 거부한다", () => {
    for (const raw of ["", " ", "abc", "0x10", "12.5", "-100", "1e9", "1 2"]) {
      expectRejected(
        () => verifyInternalSignature(SECRET, { timestamp: raw, signature: signInternal(SECRET, NOW, BODY) }, BODY, NOW),
        "bad_signature",
      );
    }
  });

  it("타임스탬프 헤더가 없으면 거부한다", () => {
    expectRejected(
      () => verifyInternalSignature(SECRET, { timestamp: undefined, signature: "sha256=deadbeef" }, BODY, NOW),
      "bad_signature",
    );
  });

  // ── 서명 위조 ──

  it("❗ 본문을 바꾸면 거부한다", () => {
    expectRejected(
      () => verifyInternalSignature(SECRET, valid(), JSON.stringify({ industries: ["dental"] }), NOW),
      "bad_signature",
    );
  });

  it("❗ 다른 비밀로 만든 서명은 거부한다", () => {
    const other = "another-internal-secret-at-least-32-chars";
    expectRejected(
      () => verifyInternalSignature(SECRET, headers(NOW, signInternal(other, NOW, BODY)), BODY, NOW),
      "bad_signature",
    );
  });

  it("❗ 접두어 없는 원시 hex 는 거부한다 (알고리즘 고정)", () => {
    const raw = createHmac("sha256", SECRET).update(`${NOW}.${BODY}`).digest("hex");
    expectRejected(() => verifyInternalSignature(SECRET, headers(NOW, raw), BODY, NOW), "bad_signature");
  });

  it("❗ 다른 알고리즘 접두어는 거부한다", () => {
    const md5 = createHmac("md5", SECRET).update(`${NOW}.${BODY}`).digest("hex");
    expectRejected(() => verifyInternalSignature(SECRET, headers(NOW, `md5=${md5}`), BODY, NOW), "bad_signature");
  });

  it("서명 헤더가 없거나 비어 있으면 거부한다", () => {
    expectRejected(() => verifyInternalSignature(SECRET, headers(NOW, ""), BODY, NOW), "bad_signature");
    expectRejected(
      () => verifyInternalSignature(SECRET, { timestamp: String(NOW), signature: undefined }, BODY, NOW),
      "bad_signature",
    );
  });

  it("길이가 다른 서명에서 timingSafeEqual 이 던지지 않는다", () => {
    expectRejected(() => verifyInternalSignature(SECRET, headers(NOW, "sha256=ab"), BODY, NOW), "bad_signature");
  });

  it("빈 본문도 서명 대상이다", () => {
    expect(() =>
      verifyInternalSignature(SECRET, headers(NOW, signInternal(SECRET, NOW, "")), "", NOW),
    ).not.toThrow();
    // 빈 본문 서명을 다른 본문에 재사용할 수 없다.
    expectRejected(
      () => verifyInternalSignature(SECRET, headers(NOW, signInternal(SECRET, NOW, "")), BODY, NOW),
      "bad_signature",
    );
  });
});
