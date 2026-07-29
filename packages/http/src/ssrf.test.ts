import { LeadOpsError } from "@leadops/core";
import { describe, expect, it } from "vitest";
import { classifyIp, parseIPv4, parseIPv6 } from "./ip";
import {
  assertPeerAllowed,
  isAmbiguousNumericHost,
  loopbackPolicyForTests,
  resolveGuarded,
  validateUrl,
  type DnsResolver,
} from "./ssrf";

describe("parseIPv4 (엄격 파서)", () => {
  it("정상 dotted-quad 를 파싱한다", () => {
    expect(Array.from(parseIPv4("1.2.3.4")!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(parseIPv4("255.255.255.255")!)).toEqual([255, 255, 255, 255]);
  });

  it("선행 0 을 거부한다 (8진수 해석 여지)", () => {
    expect(parseIPv4("0177.0.0.1")).toBeNull();
    expect(parseIPv4("010.0.0.1")).toBeNull();
  });

  it("범위 초과·형식 오류를 거부한다", () => {
    expect(parseIPv4("256.1.1.1")).toBeNull();
    expect(parseIPv4("1.2.3")).toBeNull();
    expect(parseIPv4("1.2.3.4.5")).toBeNull();
    expect(parseIPv4("a.b.c.d")).toBeNull();
  });
});

describe("parseIPv6", () => {
  it("압축 표기를 확장한다", () => {
    expect(Array.from(parseIPv6("::1")!.slice(14))).toEqual([0, 1]);
  });
  it("말미 IPv4 표기를 처리한다", () => {
    const b = parseIPv6("::ffff:127.0.0.1")!;
    expect(Array.from(b.slice(10, 16))).toEqual([0xff, 0xff, 127, 0, 0, 1]);
  });
  it("`::` 가 두 번 나오면 거부한다", () => {
    expect(parseIPv6("1::2::3")).toBeNull();
  });
});

describe("classifyIp — 차단 대역", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local (cloud metadata)"],
    ["0.0.0.0", "this-network"],
    ["100.64.0.1", "cgnat"],
    ["198.18.0.1", "benchmark"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["192.0.2.1", "test-net-1"],
  ];
  it.each(blocked)("%s 을 차단한다", (ip, reason) => {
    const v = classifyIp(ip);
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe(reason);
  });

  const blockedV6: string[] = ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1"];
  it.each(blockedV6)("IPv6 %s 을 차단한다", (ip) => {
    expect(classifyIp(ip).blocked).toBe(true);
  });

  it("IPv4-mapped IPv6 의 임베드 주소에 IPv4 규칙을 재적용한다", () => {
    const v = classifyIp("::ffff:127.0.0.1");
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("ipv4-mapped:loopback");
    expect(v.effective).toBe("127.0.0.1");
  });

  it("IPv4-mapped 로 감싼 메타데이터 주소도 차단한다", () => {
    expect(classifyIp("::ffff:169.254.169.254").blocked).toBe(true);
  });

  it("NAT64 임베드 주소에 IPv4 규칙을 재적용한다", () => {
    const v = classifyIp("64:ff9b::7f00:1"); // 64:ff9b::127.0.0.1
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("nat64:loopback");
  });

  it("❗ NAT64 프리픽스는 12바이트 전부를 검사한다", () => {
    // 앞 4바이트만 보면 이 주소가 'nat64:loopback' 으로 오분류되고,
    // 테스트 정책의 loopback 완화를 타고 통과해 버린다.
    const v = classifyIp("64:ff9b:dead:beef::7f00:1");
    expect(v.reason).not.toBe("nat64:loopback");
    expect(v.effective).not.toBe("127.0.0.1");
    // NAT64 도 아니고 전역 유니캐스트도 아니므로 기본 거부에 걸려야 한다.
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("not-global-unicast");
  });

  it("❗ IPv6 는 기본 거부 — 2000::/3 밖은 목록에 없어도 막는다", () => {
    // 2000::/3 은 2000:: ~ 3fff:: 이다. 그 밖은 인터넷에서 도달 가능한 유니캐스트가 아니다.
    for (const ip of ["64:ff9b:dead:beef::1", "0100::1", "1000::1", "4000::1", "8000::1"]) {
      expect(classifyIp(ip).blocked, ip).toBe(true);
    }
  });

  it("전역 유니캐스트 IPv6 는 통과시킨다", () => {
    for (const ip of ["2606:4700::1111", "2001:4860:4860::8888", "2400:cb00::1", "3ffe::1"]) {
      expect(classifyIp(ip).blocked, ip).toBe(false);
    }
  });

  it("6to4 임베드 주소에 IPv4 규칙을 재적용한다", () => {
    const v = classifyIp("2002:c0a8:0101::1"); // 2002:192.168.1.1
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("6to4:private");
  });

  it("공인 주소는 통과시킨다", () => {
    expect(classifyIp("8.8.8.8").blocked).toBe(false);
    expect(classifyIp("1.1.1.1").blocked).toBe(false);
    expect(classifyIp("2606:4700::1111").blocked).toBe(false);
  });

  it("6to4 로 감싼 공인 주소는 통과시킨다", () => {
    expect(classifyIp("2002:0808:0808::1").blocked).toBe(false); // 2002:8.8.8.8
  });
});

describe("validateUrl", () => {
  it("https 공인 도메인을 통과시킨다", () => {
    const v = validateUrl("https://example.kr/contact");
    expect(v.hostname).toBe("example.kr");
    expect(v.port).toBe(443);
    expect(v.literalIp).toBeUndefined();
  });

  it("http 기본 포트를 80 으로 채운다", () => {
    expect(validateUrl("http://example.kr").port).toBe(80);
  });

  const badSchemes = ["file:///etc/passwd", "ftp://example.kr", "gopher://example.kr", "data:text/html,x"];
  it.each(badSchemes)("허용되지 않은 scheme 을 거부한다: %s", (u) => {
    expect(() => validateUrl(u)).toThrowError(LeadOpsError);
  });

  it("userinfo 가 있으면 거부한다", () => {
    expect(() => validateUrl("https://user:pass@example.kr/")).toThrowError(/userinfo/);
  });

  it("허용되지 않은 포트를 거부한다", () => {
    expect(() => validateUrl("http://example.kr:8080/")).toThrowError(/port/);
    expect(() => validateUrl("http://example.kr:22/")).toThrowError(/port/);
  });

  it("사설 IP 리터럴을 거부한다", () => {
    expect(() => validateUrl("http://127.0.0.1/")).toThrowError(/차단된 IP/);
    expect(() => validateUrl("http://169.254.169.254/latest/meta-data/")).toThrowError(/차단된 IP/);
    expect(() => validateUrl("http://[::1]/")).toThrowError(/차단된 IP/);
    expect(() => validateUrl("http://[::ffff:127.0.0.1]/")).toThrowError(/차단된 IP/);
  });

  // WHATWG URL 은 숫자형 호스트를 파싱 단계에서 dotted-quad 로 정규화한다
  // (http://2130706433/ → hostname '127.0.0.1'). 따라서 최종적으로는 IP 분류에서 걸린다.
  // 중요한 것은 "차단된다"는 사실이지 어느 검사에서 걸리느냐가 아니다.
  const numericLoopback = ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/"];
  it.each(numericLoopback)("숫자형으로 위장한 loopback 을 차단한다: %s", (u) => {
    expect(() => validateUrl(u)).toThrowError(/차단된 IP 대역: 127\.0\.0\.1/);
  });

  it("숫자형으로 위장한 사설망도 차단한다", () => {
    expect(() => validateUrl("http://0xc0.0xa8.0x01.0x01/")).toThrowError(/차단된 IP 대역: 192\.168\.1\.1/);
    expect(() => validateUrl("http://2852039166/")).toThrowError(/차단된 IP 대역: 169\.254\.169\.254/);
  });

  it("공인 IP 리터럴은 통과시킨다", () => {
    expect(validateUrl("http://8.8.8.8/").literalIp).toBe("8.8.8.8");
  });
});

describe("isAmbiguousNumericHost (URL 정규화에 의존하지 않는 방어 계층)", () => {
  const ambiguous = ["2130706433", "0x7f000001", "0177.0.0.1", "010.0.0.1", "1.1", "0"];
  it.each(ambiguous)("%s 를 모호한 것으로 판정한다", (h) => {
    expect(isAmbiguousNumericHost(h)).toBe(true);
  });

  const fine = ["example.kr", "8.8.8.8", "sub.domain.co.kr", "xn--hq1bm8jm9l.kr"];
  it.each(fine)("%s 는 통과시킨다", (h) => {
    expect(isAmbiguousNumericHost(h)).toBe(false);
  });
});

describe("resolveGuarded", () => {
  const resolverOf = (records: Array<{ address: string; family: number }>): DnsResolver => async () => records;

  it("공인 주소만 반환되면 통과시킨다", async () => {
    const out = await resolveGuarded(validateUrl("https://example.kr/"), resolverOf([{ address: "93.184.216.34", family: 4 }]));
    expect(out).toHaveLength(1);
    expect(out[0]!.address).toBe("93.184.216.34");
  });

  it("사설 주소가 하나라도 섞이면 전체를 거부한다 (rebinding 대비)", async () => {
    await expect(
      resolveGuarded(
        validateUrl("https://evil.example/"),
        resolverOf([
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]),
      ),
    ).rejects.toThrowError(/차단 대역을 반환/);
  });

  it("DNS 결과가 비면 거부한다", async () => {
    await expect(resolveGuarded(validateUrl("https://nx.example/"), resolverOf([]))).rejects.toThrowError(
      /DNS 결과가 없습니다/,
    );
  });

  it("DNS 오류를 SSRF 차단으로 변환한다 (fail-closed)", async () => {
    const failing: DnsResolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(resolveGuarded(validateUrl("https://nx.example/"), failing)).rejects.toThrowError(/DNS 해석 실패/);
  });

  it("IP 리터럴은 DNS 를 거치지 않는다", async () => {
    const shouldNotRun: DnsResolver = async () => {
      throw new Error("resolver should not be called");
    };
    const out = await resolveGuarded(validateUrl("http://8.8.8.8/"), shouldNotRun);
    expect(out[0]!.address).toBe("8.8.8.8");
  });
});

describe("테스트 정책의 완화 범위 (loopback 만)", () => {
  const policy = loopbackPolicyForTests();

  it("loopback 은 허용한다", () => {
    expect(() => validateUrl("http://127.0.0.1:9999/", policy)).not.toThrow();
    expect(() => validateUrl("http://[::1]:9999/", policy)).not.toThrow();
    expect(() => assertPeerAllowed("127.0.0.1", "t", policy)).not.toThrow();
  });

  it("❗ loopback 이 아닌 사설·예약 대역은 테스트 정책에서도 막는다", () => {
    for (const ip of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "fc00::1", "fe80::1"]) {
      expect(() => assertPeerAllowed(ip, "t", policy), ip).toThrowError(/차단 대역/);
    }
  });

  it("❗ NAT64 로 위장해 loopback 완화를 타는 우회를 막는다", () => {
    // reason 문자열 접미사가 아니라 실제 주소로 판단해야 걸린다.
    expect(() => assertPeerAllowed("64:ff9b:dead:beef::7f00:1", "t", policy)).toThrowError(/차단 대역/);
  });
});

describe("assertPeerAllowed (TOCTOU 방어)", () => {
  it("연결된 peer 가 사설망이면 던진다", () => {
    expect(() => assertPeerAllowed("10.1.2.3", "hop0")).toThrowError(/peer 가 차단 대역/);
  });
  it("peer 주소를 모르면 던진다 (fail-closed)", () => {
    expect(() => assertPeerAllowed(undefined, "hop0")).toThrowError(/peer 주소를 확인할 수 없습니다/);
  });
  it("공인 peer 는 통과시킨다", () => {
    expect(() => assertPeerAllowed("93.184.216.34", "hop0")).not.toThrow();
  });
});
