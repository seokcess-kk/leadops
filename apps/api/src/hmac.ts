import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 내부 트리거 서명 검증 (`POST /internal/run` · 설계서 7.2).
 *
 * pg_cron 이 pg_net 으로 부르는 경로다. JWT 가 없으므로 **공유 비밀로 서명**한다.
 *
 * ❗ 서명 대상에 **타임스탬프를 포함**한다. 본문만 서명하면 한 번 가로챈 요청을 영원히
 *    재사용할 수 있다 (매일 같은 본문을 보내므로 특히 위험하다).
 * ❗ 비교는 `timingSafeEqual` 이다. 문자열 `===` 는 앞에서부터 끊기므로 바이트 단위로
 *    서명을 알아낼 수 있다.
 * ❗ 비밀이 설정되지 않았으면 **거부한다.** 조용히 통과시키면 이 경로가 무인증 실행 트리거가
 *    된다 — 이 저장소가 `LEADOPS_DEV_LOGIN` 과 mock 어댑터에 두는 규칙과 같다.
 */

export class HmacError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HmacError";
  }
}

/** 재생 허용 창. 짧으면 시계 오차로 실패하고, 길면 가로챈 요청의 유효 기간이 길어진다. */
export const REPLAY_WINDOW_SEC = 300;

const SIGNATURE_PREFIX = "sha256=";

export interface HmacHeaders {
  signature: string | undefined;
  timestamp: string | undefined;
}

/** 서명 문자열을 만든다. 발신·수신이 **같은 함수**를 쓰게 해서 규칙이 갈라지지 않게 한다. */
export function signInternal(secret: string, timestamp: number, body: string): string {
  return SIGNATURE_PREFIX + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // 길이가 다르면 timingSafeEqual 이 던진다. 길이 자체는 비밀이 아니므로 먼저 본다.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 서명을 검증한다. 통과하지 못하면 던진다.
 *
 * @param nowSec 현재 시각(초). 테스트가 시계를 고정할 수 있게 인자로 받는다.
 */
export function verifyInternalSignature(
  secret: string | undefined,
  headers: HmacHeaders,
  body: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  if (!secret) {
    throw new HmacError(
      "trigger_unavailable",
      "INTERNAL_TRIGGER_SECRET 이 설정되지 않았습니다. 내부 트리거는 비활성입니다.",
    );
  }
  if (secret.length < 32) {
    // 짧은 비밀은 무차별 대입으로 뚫린다. 부팅이 아니라 요청 시점에 막는 것은 운영 중
    // 비밀을 바꿔 끼웠을 때도 같은 기준이 적용되게 하기 위해서다.
    throw new HmacError("trigger_unavailable", "INTERNAL_TRIGGER_SECRET 이 너무 짧습니다 (32자 이상).");
  }

  const rawTimestamp = headers.timestamp;
  if (rawTimestamp === undefined || rawTimestamp.trim() === "") {
    throw new HmacError("bad_signature", "x-leadops-timestamp 가 없습니다");
  }
  // `Number` 는 "12 3" 같은 값을 NaN 으로 만들지만 "0x10" 을 16 으로 읽는다. 정수만 받는다.
  if (!/^\d{1,12}$/.test(rawTimestamp.trim())) {
    throw new HmacError("bad_signature", "x-leadops-timestamp 가 정수가 아닙니다");
  }
  const timestamp = Number(rawTimestamp.trim());
  if (Math.abs(nowSec - timestamp) > REPLAY_WINDOW_SEC) {
    throw new HmacError("stale_signature", `서명이 허용 시간(${REPLAY_WINDOW_SEC}초)을 벗어났습니다`);
  }

  const provided = headers.signature?.trim();
  if (provided === undefined || provided === "") {
    throw new HmacError("bad_signature", "x-leadops-signature 가 없습니다");
  }
  // 알고리즘 접두어를 강제한다. 없으면 나중에 다른 알고리즘을 받아들이는 실수가 생긴다.
  if (!provided.startsWith(SIGNATURE_PREFIX)) {
    throw new HmacError("bad_signature", "서명 형식이 올바르지 않습니다 (sha256=<hex>)");
  }

  if (!constantTimeEquals(provided, signInternal(secret, timestamp, body))) {
    throw new HmacError("bad_signature", "서명이 일치하지 않습니다");
  }
}
