import { resolve4, resolve6, resolveMx } from "node:dns/promises";

/**
 * 이메일 주소의 문법 · DNS · MX 검증 (설계서 8.2 검수 승인 게이트).
 *
 * ❗ **SMTP 접속은 하지 않는다** (설계서 1.6). 상대 메일 서버에 연결해 수신자 존재를
 *    떠보는 행위(RCPT TO 프로빙)는 하지 않는다. MX 레코드가 있는지까지만 본다.
 *
 * ❗ 이 모듈은 **검수자가 직접 입력한 주소 하나**를 검증한다. 문서에서 주소를 찾아내는
 *    것이 아니다 (정보통신망법 제50조의2 · 설계서 결론 A). 그래서 문법 검사도 정규식
 *    대신 문자열 분해로 한다 — 이메일 패턴 정규식은 저장소에 두지 않는다.
 */

/** RFC 5321 상한. 넘으면 어차피 전송되지 않는다. */
const MAX_TOTAL = 254;
const MAX_LOCAL = 64;

export interface MxVerification {
  readonly syntaxOk: boolean;
  /** 도메인이 해석되는가 (MX 또는 A/AAAA). */
  readonly dnsOk: boolean;
  /** 메일을 받을 경로가 있는가. */
  readonly mxOk: boolean;
  readonly mxHosts: readonly string[];
  /**
   * MX 레코드가 없어 A/AAAA 로 판정한 경우 (RFC 5321 implicit MX).
   *
   * 이것도 유효한 메일 경로다. 엄격하게 MX 만 요구하면 실제로 메일이 가는 도메인을
   * 탈락시켜 정당한 리드를 잃는다. 다만 어느 경로로 통과했는지는 남긴다.
   */
  readonly implicitMx: boolean;
  /** 0~1. 승인 판단의 보조 지표. */
  readonly confidence: number;
  /** 실패 사유. 통과하면 없다. */
  readonly reason?: string | undefined;
  readonly domain?: string | undefined;
}

/**
 * 문법 검사.
 *
 * DB 의 `enter_contact_email` 이 쓰는 규칙과 **같은 것을 판정한다** — 구분자 하나,
 * 앞뒤가 모두 비어 있지 않고, 공백이 없고, 도메인에 점이 하나 이상 있어야 한다.
 * 둘이 어긋나면 API 는 통과시키고 DB 가 거절하는 상태가 된다.
 *
 * ❗ 정규식이 아니라 문자열 분해로 판정한다. 주소 패턴 정규식은 저장소에 두지 않는다
 *    (`packages/core/src/policy.test.ts` 가 이것을 강제한다). 주석에도 쓰지 않는다.
 */
export function checkSyntax(address: string): { ok: boolean; local?: string; domain?: string; reason?: string } {
  const value = address.trim();
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > MAX_TOTAL) return { ok: false, reason: "too_long" };

  const at = value.indexOf("@");
  if (at <= 0) return { ok: false, reason: "no_local_part" };
  if (value.indexOf("@", at + 1) !== -1) return { ok: false, reason: "multiple_at" };

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > MAX_LOCAL) return { ok: false, reason: "local_too_long" };
  if (domain.length === 0) return { ok: false, reason: "no_domain" };
  if (/\s/.test(value)) return { ok: false, reason: "whitespace" };

  // 도메인은 점을 포함해야 하고, 점으로 시작·끝나거나 연속될 수 없다.
  if (!domain.includes(".")) return { ok: false, reason: "domain_without_dot" };
  if (domain.startsWith(".") || domain.endsWith(".")) return { ok: false, reason: "domain_dot_edge" };
  if (domain.includes("..")) return { ok: false, reason: "domain_double_dot" };

  return { ok: true, local, domain: domain.toLowerCase() };
}

export interface MxResolver {
  mx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  a(domain: string): Promise<string[]>;
  aaaa(domain: string): Promise<string[]>;
}

/** 실제 DNS. 테스트는 자체 리졸버를 주입한다. */
export const systemResolver: MxResolver = {
  mx: (domain) => resolveMx(domain),
  a: (domain) => resolve4(domain),
  aaaa: (domain) => resolve6(domain),
};

const fail = (reason: string, syntaxOk = true, domain?: string): MxVerification => ({
  syntaxOk,
  dnsOk: false,
  mxOk: false,
  mxHosts: [],
  implicitMx: false,
  confidence: 0,
  reason,
  ...(domain === undefined ? {} : { domain }),
});

/**
 * 주소 하나를 검증한다.
 *
 * 순서가 그대로 검수 화면의 진행 표시가 된다: 문법 → DNS → MX.
 * 앞 단계가 실패하면 뒤를 조회하지 않는다 — 실패한 도메인에 DNS 질의를 반복할 이유가 없다.
 */
export async function verifyEmailAddress(
  address: string,
  resolver: MxResolver = systemResolver,
): Promise<MxVerification> {
  const syntax = checkSyntax(address);
  if (!syntax.ok || !syntax.domain) return fail(syntax.reason ?? "invalid_syntax", false);
  const domain = syntax.domain;

  let mxHosts: string[] = [];
  try {
    const records = await resolver.mx(domain);
    mxHosts = records
      .filter((r) => typeof r.exchange === "string" && r.exchange.trim().length > 0)
      // `.` 하나만 오는 "null MX"(RFC 7505)는 **메일을 받지 않겠다는 선언**이다.
      .filter((r) => r.exchange.trim() !== ".")
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.trim().toLowerCase());
  } catch {
    mxHosts = [];
  }

  if (mxHosts.length > 0) {
    return { syntaxOk: true, dnsOk: true, mxOk: true, mxHosts, implicitMx: false, confidence: 0.9, domain };
  }

  // MX 가 없으면 A/AAAA 로 implicit MX 를 확인한다 (RFC 5321 §5.1).
  let hasAddress = false;
  try {
    hasAddress = (await resolver.a(domain)).length > 0;
  } catch {
    hasAddress = false;
  }
  if (!hasAddress) {
    try {
      hasAddress = (await resolver.aaaa(domain)).length > 0;
    } catch {
      hasAddress = false;
    }
  }

  if (hasAddress) {
    return {
      syntaxOk: true,
      dnsOk: true,
      mxOk: true,
      mxHosts: [],
      implicitMx: true,
      confidence: 0.6,
      domain,
    };
  }

  return fail("domain_not_resolvable", true, domain);
}
