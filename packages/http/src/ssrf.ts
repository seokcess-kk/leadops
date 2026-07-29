import { lookup as dnsLookup } from "node:dns/promises";
import { ssrfBlocked } from "@leadops/core";
import { classifyIp, isLoopbackAddress, type IpVerdict } from "./ip";

/**
 * SSRF 방어 (설계서 3.5절).
 *
 * 흐름:
 *   1. URL 형태 검증  — scheme / port / userinfo / 호스트 표기
 *   2. DNS 해석       — 반환된 **모든** 주소를 검사
 *   3. 연결은 검증된 IP 로 직접  (Host 헤더 보존) → DNS rebinding 차단
 *   4. 소켓 연결 직후 실제 peer IP 재검사
 *   5. redirect 마다 1~4 반복
 *
 * 이 모듈은 1·2·4 를 담당한다. 3·5 는 HttpClient 가 수행한다.
 */

export const ALLOWED_PROTOCOLS = Object.freeze(["http:", "https:"]);
export const ALLOWED_PORTS = Object.freeze([80, 443]);

/**
 * SSRF 정책.
 *
 * 통합 테스트는 로컬 HTTP 서버(127.0.0.1)를 띄워야 하는데, 그것을 허용하려면
 * 가드에 구멍이 필요하다. 그 구멍을 **명시적이고 좁고 자기방어적으로** 만든다:
 *
 *  - 기본값은 항상 `ENFORCE`
 *  - 완화는 loopback **하나만**. link-local(169.254.x = 클라우드 메타데이터),
 *    사설 대역, CGNAT 는 테스트에서도 절대 열리지 않는다.
 *  - `NODE_ENV=test` 가 아니면 정책 생성 자체가 실패한다.
 *  - 포트 제한도 완화된다 (테스트 서버는 임의 포트를 쓰므로).
 */
export interface SsrfPolicy {
  readonly allowLoopback: boolean;
  readonly allowAnyPort: boolean;
}

export const ENFORCE: SsrfPolicy = Object.freeze({ allowLoopback: false, allowAnyPort: false });

/** 테스트 전용 완화 정책. 프로덕션에서 호출하면 던진다. */
export function loopbackPolicyForTests(): SsrfPolicy {
  if (process.env["NODE_ENV"] !== "test") {
    throw ssrfBlocked("loopbackPolicyForTests() 는 NODE_ENV=test 에서만 사용할 수 있습니다", {
      nodeEnv: process.env["NODE_ENV"] ?? "(unset)",
    });
  }
  return Object.freeze({ allowLoopback: true, allowAnyPort: true });
}

/**
 * 정책을 반영해 판정 결과를 해석한다. loopback 만, 그것도 명시적으로 허용된 경우에만 통과.
 *
 * ❗ `reason` 문자열이 아니라 **실제 주소**로 판단한다. 문자열 접미사(`:loopback`)로
 *    판단하면 `nat64:loopback` 같은 합성 사유가 완화를 타고 들어올 수 있다.
 */
function isBlockedUnderPolicy(verdict: IpVerdict, policy: SsrfPolicy): boolean {
  if (!verdict.blocked) return false;
  if (policy.allowLoopback && isLoopbackAddress(verdict.effective)) return false;
  return true;
}

/**
 * DNS 이름으로 위장한 숫자형 호스트를 걸러낸다.
 *
 * `2130706433`, `0x7f000001`, `0177.0.0.1` 은 리졸버·라이브러리마다 해석이 달라
 * 127.0.0.1 에 도달할 수 있다.
 *
 * 참고: WHATWG `new URL()` 은 이 표기들을 **파싱 단계에서 dotted-quad 로 정규화**한다
 * (`http://2130706433/`.hostname === `'127.0.0.1'`). 따라서 `validateUrl()` 경로에서는
 * 대부분 IP 분류 단계에서 먼저 걸린다. 이 함수는 그 정규화에 의존하지 않기 위한
 * 방어 계층이며, URL 을 거치지 않고 호스트 문자열을 직접 받는 경로에서 유효하다.
 */
export function isAmbiguousNumericHost(host: string): boolean {
  if (/^\d+$/.test(host)) return true; // 32비트 정수 표기
  if (/^0[xX][0-9a-fA-F]+$/.test(host)) return true; // 16진수
  // 점으로 나뉜 숫자인데 엄격한 dotted-quad 가 아닌 것 (선행 0, 3자리 미만 그룹 수 등)
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split(".");
    if (parts.length !== 4) return true;
    return parts.some((p) => p.length > 1 && p.startsWith("0"));
  }
  return false;
}

export interface ValidatedUrl {
  url: URL;
  hostname: string;
  port: number;
  /** 호스트가 IP 리터럴이면 그 값. DNS 이름이면 undefined. */
  literalIp?: string;
}

/** 1단계 — URL 형태 검증. 통과 못 하면 던진다. */
export function validateUrl(raw: string | URL, policy: SsrfPolicy = ENFORCE): ValidatedUrl {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw ssrfBlocked(`URL 을 파싱할 수 없습니다: ${String(raw)}`, { raw: String(raw) });
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    throw ssrfBlocked(`허용되지 않은 scheme: ${url.protocol}`, { url: url.href });
  }
  if (url.username !== "" || url.password !== "") {
    throw ssrfBlocked("URL 에 userinfo(user:pass@) 가 포함되어 있습니다", { url: url.origin });
  }

  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!policy.allowAnyPort && !ALLOWED_PORTS.includes(port)) {
    throw ssrfBlocked(`허용되지 않은 port: ${port}`, { url: url.href, port });
  }

  // URL 의 hostname 은 IPv6 를 대괄호 없이 준다.
  const hostname = url.hostname;
  if (hostname.length === 0) {
    throw ssrfBlocked("호스트가 비어 있습니다", { url: url.href });
  }
  if (isAmbiguousNumericHost(hostname)) {
    throw ssrfBlocked(`해석이 모호한 숫자형 호스트: ${hostname}`, { hostname });
  }

  const verdict = classifyIp(hostname);
  const isLiteral = verdict.reason !== "parse_failed";
  if (isLiteral) {
    if (isBlockedUnderPolicy(verdict, policy)) {
      throw ssrfBlocked(`차단된 IP 대역: ${verdict.effective} (${verdict.reason})`, {
        hostname,
        effective: verdict.effective,
        reason: verdict.reason,
      });
    }
    return { url, hostname, port, literalIp: verdict.effective };
  }

  return { url, hostname, port };
}

export interface ResolvedTarget {
  hostname: string;
  port: number;
  /** 실제로 연결할 IP. 검증을 통과한 값만 들어온다. */
  address: string;
  family: 4 | 6;
}

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: DnsResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
};

/**
 * 2단계 — DNS 해석 후 전 주소 검증.
 *
 * **하나라도 사설망을 가리키면 전체를 거부한다.** 통과한 것만 골라 쓰지 않는 이유는,
 * 공격자가 공인 IP 와 사설 IP 를 함께 반환해 재시도 시 사설 IP 에 붙게 만들 수 있기 때문이다.
 */
export async function resolveGuarded(
  validated: ValidatedUrl,
  resolver: DnsResolver = defaultResolver,
  policy: SsrfPolicy = ENFORCE,
): Promise<ResolvedTarget[]> {
  if (validated.literalIp) {
    const family = validated.literalIp.includes(":") ? 6 : 4;
    return [
      { hostname: validated.hostname, port: validated.port, address: validated.literalIp, family },
    ];
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await resolver(validated.hostname);
  } catch (cause) {
    throw ssrfBlocked(`DNS 해석 실패: ${validated.hostname}`, { hostname: validated.hostname, cause: String(cause) });
  }
  if (records.length === 0) {
    throw ssrfBlocked(`DNS 결과가 없습니다: ${validated.hostname}`, { hostname: validated.hostname });
  }

  for (const rec of records) {
    const verdict = classifyIp(rec.address);
    if (isBlockedUnderPolicy(verdict, policy)) {
      throw ssrfBlocked(
        `DNS 가 차단 대역을 반환했습니다: ${validated.hostname} → ${verdict.effective} (${verdict.reason})`,
        { hostname: validated.hostname, address: rec.address, reason: verdict.reason },
      );
    }
  }

  return records.map((r) => ({
    hostname: validated.hostname,
    port: validated.port,
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));
}

/**
 * 4단계 — 소켓이 붙은 뒤 실제 peer IP 재검사.
 *
 * TOCTOU 방어. 여기서 걸리면 소켓을 즉시 끊어야 한다.
 */
export function assertPeerAllowed(
  remoteAddress: string | undefined,
  context: string,
  policy: SsrfPolicy = ENFORCE,
): void {
  if (!remoteAddress) {
    throw ssrfBlocked(`peer 주소를 확인할 수 없습니다 (${context})`, { context });
  }
  const verdict = classifyIp(remoteAddress);
  if (isBlockedUnderPolicy(verdict, policy)) {
    throw ssrfBlocked(`연결된 peer 가 차단 대역입니다: ${verdict.effective} (${verdict.reason})`, {
      context,
      remoteAddress,
      reason: verdict.reason,
    });
  }
}
