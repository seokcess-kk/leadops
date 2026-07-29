/**
 * IP 주소 파싱과 사설·예약 대역 분류.
 *
 * 설계서 R8 / R2-31 대응. 라이브러리 없이 직접 구현한 이유는 이 로직이
 * 보안 경계이고, 동작을 테스트로 전부 고정해 두어야 하기 때문이다.
 *
 * 특히 다음을 놓치지 않는다 (codex 라운드 2 지적):
 *  - IPv4-mapped IPv6  (::ffff:127.0.0.1)
 *  - NAT64             (64:ff9b::7f00:1)
 *  - 6to4              (2002:7f00:0001::)
 *  - benchmark / multicast / reserved 대역
 *  - 8진수·16진수·정수형 IP 표기 (0177.0.0.1, 0x7f000001, 2130706433)
 */

export type IpFamily = 4 | 6;

export interface ParsedIp {
  family: IpFamily;
  /** 16바이트 정규형. IPv4 는 IPv4-mapped 형태로 채운다. */
  bytes: Uint8Array;
  /** 정규화된 표기. */
  canonical: string;
}

// ── IPv4 ────────────────────────────────────────────────────────────────────

/**
 * 엄격한 dotted-quad 파서.
 *
 * 선행 0 을 허용하지 않는다. "0177.0.0.1" 을 10진수로 읽으면 177.0.0.1 이 되지만
 * 일부 리졸버는 8진수로 읽어 127.0.0.1 에 도달한다. 해석이 갈리는 입력은 거부한다.
 */
export function parseIPv4(input: string): Uint8Array | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i] as string;
    if (p.length === 0 || p.length > 3) return null;
    if (!/^\d+$/.test(p)) return null;
    if (p.length > 1 && p.startsWith("0")) return null; // 8진수 해석 여지 차단
    const n = Number(p);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

// ── IPv6 ────────────────────────────────────────────────────────────────────

/** IPv6 파서. `::` 압축과 말미 IPv4 표기(::ffff:1.2.3.4)를 지원한다. */
export function parseIPv6(input: string): Uint8Array | null {
  let s = input;
  if (s.includes("%")) s = s.slice(0, s.indexOf("%")); // zone id 제거
  if (s.length === 0) return null;

  // 말미 IPv4 표기 분리
  let tailV4: Uint8Array | null = null;
  const lastColon = s.lastIndexOf(":");
  if (lastColon >= 0 && s.slice(lastColon + 1).includes(".")) {
    tailV4 = parseIPv4(s.slice(lastColon + 1));
    if (!tailV4) return null;
    s = s.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColonCount = s.split("::").length - 1;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];
  if (doubleColonCount === 1) {
    const [h = "", t = ""] = s.split("::");
    head = h === "" ? [] : h.split(":");
    tail = t === "" ? [] : t.split(":");
  } else {
    head = s.split(":");
    tail = [];
  }

  const groupCount = head.length + tail.length;
  if (doubleColonCount === 0 && groupCount !== 8) return null;
  if (doubleColonCount === 1 && groupCount > 7) return null;

  const toWord = (g: string): number | null => {
    if (g.length === 0 || g.length > 4) return null;
    if (!/^[0-9a-fA-F]+$/.test(g)) return null;
    return parseInt(g, 16);
  };

  const words: number[] = [];
  for (const g of head) {
    const w = toWord(g);
    if (w === null) return null;
    words.push(w);
  }
  const fill = 8 - groupCount;
  for (let i = 0; i < fill; i++) words.push(0);
  for (const g of tail) {
    const w = toWord(g);
    if (w === null) return null;
    words.push(w);
  }
  if (words.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const w = words[i] as number;
    bytes[i * 2] = (w >> 8) & 0xff;
    bytes[i * 2 + 1] = w & 0xff;
  }
  if (tailV4) bytes.set(tailV4, 12);
  return bytes;
}

// ── 통합 파서 ───────────────────────────────────────────────────────────────

const V4_MAPPED_PREFIX = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);
/** 64:ff9b:0:0:0:0::/96 — 12바이트 전부가 프리픽스다. */
const NAT64_PREFIX = new Uint8Array([0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]);

function toMapped(v4: Uint8Array): Uint8Array {
  const b = new Uint8Array(16);
  b.set(V4_MAPPED_PREFIX, 0);
  b.set(v4, 12);
  return b;
}

export function parseIp(input: string): ParsedIp | null {
  const trimmed = input.trim().replace(/^\[|\]$/g, "");
  if (trimmed.length === 0) return null;

  const v4 = parseIPv4(trimmed);
  if (v4) {
    return { family: 4, bytes: toMapped(v4), canonical: Array.from(v4).join(".") };
  }
  const v6 = parseIPv6(trimmed);
  if (v6) {
    return { family: 6, bytes: v6, canonical: formatIPv6(v6) };
  }
  return null;
}

export function formatIPv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((bytes[i] as number) << 8) | (bytes[i + 1] as number)).toString(16));
  }
  return groups.join(":");
}

// ── CIDR 매칭 ───────────────────────────────────────────────────────────────

interface Cidr {
  bytes: Uint8Array;
  prefix: number;
  label: string;
}

function cidr(notation: string, label: string): Cidr {
  const [addr = "", prefixStr = ""] = notation.split("/");
  const parsed = parseIp(addr);
  if (!parsed) throw new Error(`invalid CIDR in table: ${notation}`);
  const declared = Number(prefixStr);
  // IPv4 표기는 내부적으로 mapped(96비트 오프셋)로 저장하므로 프리픽스를 옮긴다.
  const prefix = parsed.family === 4 ? declared + 96 : declared;
  return { bytes: parsed.bytes, prefix, label };
}

function inCidr(bytes: Uint8Array, net: Cidr): boolean {
  const fullBytes = net.prefix >> 3;
  const remBits = net.prefix & 7;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== net.bytes[i]) return false;
  }
  if (remBits === 0) return true;
  const mask = (0xff << (8 - remBits)) & 0xff;
  return ((bytes[fullBytes] as number) & mask) === ((net.bytes[fullBytes] as number) & mask);
}

/** 외부로 나가면 안 되는 대역. */
const BLOCKED: readonly Cidr[] = [
  // IPv4
  cidr("0.0.0.0/8", "this-network"),
  cidr("10.0.0.0/8", "private"),
  cidr("100.64.0.0/10", "cgnat"),
  cidr("127.0.0.0/8", "loopback"),
  cidr("169.254.0.0/16", "link-local (cloud metadata)"),
  cidr("172.16.0.0/12", "private"),
  cidr("192.0.0.0/24", "ietf-protocol"),
  cidr("192.0.2.0/24", "test-net-1"),
  cidr("192.88.99.0/24", "6to4-relay-anycast"),
  cidr("192.168.0.0/16", "private"),
  cidr("198.18.0.0/15", "benchmark"),
  cidr("198.51.100.0/24", "test-net-2"),
  cidr("203.0.113.0/24", "test-net-3"),
  cidr("224.0.0.0/4", "multicast"),
  cidr("240.0.0.0/4", "reserved"),
  // IPv6
  cidr("::/128", "unspecified"),
  cidr("::1/128", "loopback"),
  cidr("fc00::/7", "unique-local"),
  cidr("fe80::/10", "link-local"),
  cidr("ff00::/8", "multicast"),
  cidr("2001:db8::/32", "documentation"),
  cidr("100::/64", "discard-only"),
];

export interface IpVerdict {
  blocked: boolean;
  reason?: string;
  /** 정규화 과정에서 실제로 검사한 최종 주소 (mapped/NAT64/6to4 해제 결과 포함). */
  effective: string;
}

/**
 * 주소가 공인망 주소인지 판정한다.
 *
 * IPv4-mapped · NAT64 · 6to4 는 임베드된 IPv4 를 꺼내 **IPv4 규칙을 다시 적용**한다.
 * 이 재적용이 없으면 `::ffff:127.0.0.1` 같은 우회가 통과한다.
 */
export function classifyIp(input: string): IpVerdict {
  const parsed = parseIp(input);
  if (!parsed) return { blocked: true, reason: "parse_failed", effective: input };

  // IPv4-mapped ::ffff:a.b.c.d → IPv4 재적용
  if (parsed.family === 6 && startsWith(parsed.bytes, V4_MAPPED_PREFIX)) {
    return recheckEmbeddedV4(parsed.bytes.subarray(12, 16), "ipv4-mapped");
  }
  // NAT64 64:ff9b::/96 → 임베드 IPv4 재적용
  // ❗ 프리픽스는 **12바이트 전부** 확인해야 한다. 앞 4바이트만 보면
  //    64:ff9b:dead:beef::7f00:1 같은 주소가 NAT64 로 오분류되어,
  //    reason 이 'nat64:loopback' 이 되고 테스트 정책의 loopback 완화를 타고 통과한다.
  if (parsed.family === 6 && startsWith(parsed.bytes, NAT64_PREFIX)) {
    return recheckEmbeddedV4(parsed.bytes.subarray(12, 16), "nat64");
  }
  // 6to4 2002::/16 → 임베드 IPv4 재적용
  if (parsed.family === 6 && parsed.bytes[0] === 0x20 && parsed.bytes[1] === 0x02) {
    return recheckEmbeddedV4(parsed.bytes.subarray(2, 6), "6to4");
  }

  for (const net of BLOCKED) {
    if (inCidr(parsed.bytes, net)) {
      return { blocked: true, reason: net.label, effective: parsed.canonical };
    }
  }

  // ❗ IPv6 는 **기본 거부**다. 인터넷에서 도달 가능한 IPv6 유니캐스트는 2000::/3 뿐이므로,
  //    그 밖은 차단 목록에 명시되어 있지 않아도 전부 막는다.
  //    (차단 목록 방식만 쓰면 `64:ff9b:dead:beef::` 처럼 어느 항목에도 걸리지 않는
  //     비할당 주소가 조용히 통과한다.)
  if (parsed.family === 6 && !inCidr(parsed.bytes, GLOBAL_UNICAST_V6)) {
    return { blocked: true, reason: "not-global-unicast", effective: parsed.canonical };
  }

  return { blocked: false, effective: parsed.canonical };
}

/** 인터넷 도달 가능한 IPv6 유니캐스트 대역. 이 밖은 전부 거부한다. */
const GLOBAL_UNICAST_V6 = cidr("2000::/3", "global-unicast");

function recheckEmbeddedV4(v4: Uint8Array, via: string): IpVerdict {
  const dotted = Array.from(v4).join(".");
  const inner = classifyIp(dotted);
  return inner.blocked
    ? { blocked: true, reason: `${via}:${inner.reason}`, effective: dotted }
    : { blocked: false, effective: dotted };
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * 주소가 **정말로** loopback 인지 판정한다.
 *
 * 정책 완화(테스트용 loopback 허용)는 `reason` 문자열 접미사가 아니라 이 함수로 판단한다.
 * 문자열 비교에 의존하면 `nat64:loopback` 같은 합성 사유가 완화를 타고 들어온다.
 */
export function isLoopbackAddress(input: string): boolean {
  const parsed = parseIp(input);
  if (!parsed) return false;
  if (parsed.family === 4 || startsWith(parsed.bytes, V4_MAPPED_PREFIX)) {
    return parsed.bytes[12] === 127;
  }
  return inCidr(parsed.bytes, LOOPBACK_V6);
}

const LOOPBACK_V6 = cidr("::1/128", "loopback");
