import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeadOpsError, nullLogger } from "@leadops/core";
import type { HttpClient } from "@leadops/http";
import { describe, expect, it } from "vitest";
import { formatVerification, verifyFtc, verifyHira } from "./verify";

/**
 * 검증 도구 자체의 테스트.
 *
 * 실 API 호출은 여기서 하지 않는다 — 그건 `pnpm spike verify` 가 한다.
 * 여기서 보장하는 것은 **응답이 이러이러할 때 진단이 올바른가** 이다.
 */

/** URL 패턴 → 응답을 매핑하는 가짜 HttpClient. */
function fakeHttp(routes: Array<{ match: RegExp; body?: string; status?: number }>): HttpClient {
  return {
    async get(url: string) {
      for (const r of routes) {
        if (!r.match.test(url)) continue;
        if (r.status !== undefined) {
          throw new LeadOpsError("http_error", `HTTP ${r.status}`, { details: { status: r.status } });
        }
        return { status: 200, finalUrl: url, headers: {}, body: r.body ?? "", hops: [], truncated: false };
      }
      throw new LeadOpsError("http_error", "HTTP 500", { details: { status: 500 } });
    },
  } as unknown as HttpClient;
}

const envelope = (items: unknown[], totalCount = items.length): string =>
  JSON.stringify({
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL SERVICE" },
      body: { items: { item: items }, totalCount, pageNo: 1, numOfRows: items.length },
    },
  });

const derm = (n: number, keyword = "피부과"): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    ykiho: `y${i}`,
    yadmNm: `테스트${keyword}의원${i}`,
    addr: "서울특별시 강남구 1",
    telno: "02-000-0000",
  }));

const baseOptions = { serviceKey: "k", logger: nullLogger };

describe("verifyHira — 엔드포인트 탐색", () => {
  it("첫 후보가 동작하면 pass 를 준다", async () => {
    const http = fakeHttp([{ match: /hospInfoServicev2/, body: envelope(derm(10)) }]);
    const r = await verifyHira({ ...baseOptions, http });
    const endpoint = r.checks.find((c) => c.name === "엔드포인트")!;
    expect(endpoint.status).toBe("pass");
    expect(r.workingEndpoint).toContain("hospInfoServicev2");
  });

  it("❗ 다른 후보가 동작하면 warn 과 함께 그 값을 알려준다", async () => {
    const http = fakeHttp([
      { match: /hospInfoServicev2/, status: 500 },
      { match: /hospInfoService1/, body: envelope(derm(10)) },
    ]);
    const r = await verifyHira({ ...baseOptions, http });
    const endpoint = r.checks.find((c) => c.name === "엔드포인트")!;
    expect(endpoint.status).toBe("warn");
    expect(endpoint.detail).toContain("고치세요");
    expect(endpoint.evidence).toContain("hospInfoService1");
  });

  it("전부 실패하면 상태코드별 진단을 남긴다", async () => {
    const http = fakeHttp([
      { match: /hospInfoServicev2/, status: 401 },
      { match: /hospInfoService1/, status: 500 },
      { match: /hospInfoService\//, status: 403 },
    ]);
    const r = await verifyHira({ ...baseOptions, http });
    expect(r.status).toBe("fail");
    const ev = r.checks[0]!.evidence!;
    // 401 은 "경로는 맞다" 는 신호다 — 사용자가 키를 의심하게 만들어야 한다.
    expect(ev).toContain("경로는 맞습니다");
    expect(ev).toContain("포털이 500");
    expect(ev).toContain("승인 대기");
  });

  it("resultCode 가 00 이 아니면 다음 후보로 넘어간다", async () => {
    const bad = JSON.stringify({ response: { header: { resultCode: "30", resultMsg: "SERVICE KEY IS NOT REGISTERED" } } });
    const http = fakeHttp([
      { match: /hospInfoServicev2/, body: bad },
      { match: /hospInfoService1/, body: envelope(derm(10)) },
    ]);
    const r = await verifyHira({ ...baseOptions, http });
    expect(r.workingEndpoint).toContain("hospInfoService1");
  });
});

describe("verifyHira — 응답 검사", () => {
  it("필수 필드가 있으면 pass", async () => {
    const http = fakeHttp([{ match: /./, body: envelope(derm(10)) }]);
    const r = await verifyHira({ ...baseOptions, http });
    expect(r.checks.find((c) => c.name === "필수 필드")!.status).toBe("pass");
  });

  it("❗ 필드명이 다르면 fail 하고 관찰된 키를 보여준다", async () => {
    const wrong = [{ hospitalId: "x", hospitalName: "테스트피부과" }];
    const http = fakeHttp([{ match: /./, body: envelope(wrong) }]);
    const r = await verifyHira({ ...baseOptions, http });
    const check = r.checks.find((c) => c.name === "필수 필드")!;
    expect(check.status).toBe("fail");
    expect(check.evidence).toContain("hospitalId");
    expect(check.detail).toContain("ykiho");
  });

  it("항목이 0건이면 fail", async () => {
    const http = fakeHttp([{ match: /./, body: envelope([], 0) }]);
    const r = await verifyHira({ ...baseOptions, http });
    expect(r.status).toBe("fail");
    expect(r.checks.some((c) => c.name === "응답 항목" && c.status === "fail")).toBe(true);
  });
});

/**
 * 이름 구성을 통제한 표본을 만든다.
 *
 * 진료과목 코드는 **대조군 대비 상승도**로 판정하므로, 대조군과 처리군의
 * 키워드 비율을 따로 통제해야 의미 있는 테스트가 된다.
 */
const namesWith = (total: number, counts: Record<string, number>): unknown[] => {
  const out: unknown[] = [];
  let i = 0;
  for (const [keyword, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++, i++) out.push({ ykiho: `y${i}`, yadmNm: `테스트${keyword}의원${i}`, addr: "서울 1" });
  }
  for (; i < total; i++) out.push({ ykiho: `y${i}`, yadmNm: `테스트의원${i}`, addr: "서울 1" });
  return out;
};

/** 대조군 2%/3%, 처리군은 해당 과목이 크게 늘어난 정상 케이스. */
const healthyRoutes = [
  { match: /dgsbjtCd=14/, body: envelope(namesWith(100, { 피부과: 40 })) },
  { match: /dgsbjtCd=08/, body: envelope(namesWith(100, { 성형외과: 30 })) },
  { match: /clCd=51/, body: envelope(namesWith(100, { 치과: 100 })) },
  { match: /clCd=31/, body: envelope(namesWith(100, { 피부과: 2, 성형외과: 3 })) },
  { match: /./, body: envelope(namesWith(100, {})) },
];

describe("❗ verifyHira — 진료과목 코드는 상승도로 판정한다", () => {
  it("상승도가 충분하면 pass", async () => {
    const r = await verifyHira({ ...baseOptions, http: fakeHttp(healthyRoutes) });
    expect(r.checks.find((c) => c.name === "진료과목 코드 (derm: dgsbjtCd=14)")!.status).toBe("pass");
    expect(r.checks.find((c) => c.name === "진료과목 코드 (plastic: dgsbjtCd=08)")!.status).toBe("pass");
    expect(r.checks.find((c) => c.name === "종별 코드 (dental: clCd=51)")!.status).toBe("pass");
  });

  it("❗ 코드가 틀리면(대조군과 차이 없음) fail 하고 대체 코드를 탐색한다", async () => {
    const http = fakeHttp([
      { match: /dgsbjtCd=14/, body: envelope(namesWith(100, { 피부과: 2 })) },
      { match: /dgsbjtCd=22/, body: envelope(namesWith(100, { 피부과: 45 })) },
      ...healthyRoutes.slice(1),
    ]);
    const r = await verifyHira({ ...baseOptions, http });
    const check = r.checks.find((c) => c.name === "진료과목 코드 (derm: dgsbjtCd=14)")!;
    expect(check.status).toBe("fail");
    expect(check.evidence).toContain("탐색 결과");
    expect(check.evidence).toContain("dgsbjtCd=22");
  });

  it("검사 결과가 증명이 아니라 신호임을 명시한다", async () => {
    const r = await verifyHira({ ...baseOptions, http: fakeHttp(healthyRoutes) });
    expect(r.checks.find((c) => c.name === "진료과목 코드 (derm: dgsbjtCd=14)")!.detail).toContain("증명이 아니라");
  });

  it("❗ 코드표를 직접 읽을 수 있으면 그것을 우선한다 (휴리스틱보다 강한 증거)", async () => {
    const table = envelope([
      { dgsbjtCd: "14", dgsbjtCdNm: "피부과" },
      { dgsbjtCd: "08", dgsbjtCdNm: "성형외과" },
    ]);
    const http = fakeHttp([{ match: /getDgsbjtInfo/, body: table }, ...healthyRoutes]);
    const r = await verifyHira({ ...baseOptions, http });
    const check = r.checks.find((c) => c.name === "진료과목 코드표 (dgsbjtCd=14)")!;
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("확정");
  });

  it("❗ 코드표가 다른 이름을 주면 fail 하고 실제 이름을 알려준다", async () => {
    const table = envelope([{ dgsbjtCd: "14", dgsbjtCdNm: "안과" }]);
    const http = fakeHttp([{ match: /getDgsbjtInfo/, body: table }, ...healthyRoutes]);
    const r = await verifyHira({ ...baseOptions, http });
    const check = r.checks.find((c) => c.name === "진료과목 코드표 (dgsbjtCd=14)")!;
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("'안과'");
  });

  it("코드표에 접근할 수 없으면 warn 으로 알리고 휴리스틱으로 넘어간다", async () => {
    const r = await verifyHira({ ...baseOptions, http: fakeHttp(healthyRoutes) });
    const check = r.checks.find((c) => c.name === "진료과목 코드표")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("15001699");
  });
});

describe("verifyHira — fixture 녹화", () => {
  it("실제 응답을 파일로 남긴다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leadops-fx-"));
    const body = envelope(derm(3));
    const http = fakeHttp([{ match: /./, body }]);
    await verifyHira({ ...baseOptions, http, fixtureDir: dir });

    const saved = readFileSync(join(dir, "hira-getHospBasisList-derm.json"), "utf8");
    expect(JSON.parse(saved)).toEqual(JSON.parse(body));
  });

  it("fixtureDir 이 없으면 녹화하지 않는다", async () => {
    const http = fakeHttp([{ match: /./, body: envelope(derm(3)) }]);
    const r = await verifyHira({ ...baseOptions, http });
    expect(r.checks.some((c) => c.name === "fixture 녹화")).toBe(false);
  });
});

describe("verifyFtc", () => {
  const brands = [
    { brandMgtNo: "B1", brandNm: "테스트커피", jnghdqrtrsNm: "테스트에프앤비", bizrno: "123-45-67890" },
  ];

  it("정상 응답이면 pass", async () => {
    const http = fakeHttp([{ match: /FftcBrandRegistrationService\//, body: envelope(brands) }]);
    const r = await verifyFtc({ ...baseOptions, http });
    expect(r.checks.find((c) => c.name === "필수 필드")!.status).toBe("pass");
  });

  it("❗ 대표자명이 응답에 있으면 경고한다 (개인정보)", async () => {
    const withName = [{ ...brands[0], reprsntNm: "홍길동" }];
    const http = fakeHttp([{ match: /./, body: envelope(withName) }]);
    const r = await verifyFtc({ ...baseOptions, http });
    expect(r.checks.find((c) => c.name === "개인정보 필드")!.status).toBe("warn");
  });

  it("식별자 필드명이 다르면 fail", async () => {
    const http = fakeHttp([{ match: /./, body: envelope([{ someOtherId: "x", someName: "y" }]) }]);
    const r = await verifyFtc({ ...baseOptions, http });
    expect(r.checks.find((c) => c.name === "필수 필드")!.status).toBe("fail");
  });
});

describe("formatVerification", () => {
  it("실패 시 다음에 할 일을 알려준다", async () => {
    const http = fakeHttp([{ match: /./, status: 500 }]);
    const out = formatVerification([await verifyHira({ ...baseOptions, http })]);
    expect(out).toContain("검증 실패");
    expect(out).toContain("verifiedAgainstLiveApi` 는 false 로 두세요");
  });

  it("성공 시 플래그를 켜라고 알려준다", async () => {
    // 코드표까지 직접 읽히는 완전 통과 상태를 만든다.
    const table = envelope([
      { dgsbjtCd: "14", dgsbjtCdNm: "피부과" },
      { dgsbjtCd: "08", dgsbjtCdNm: "성형외과" },
    ]);
    const hira = await verifyHira({
      ...baseOptions,
      http: fakeHttp([{ match: /getDgsbjtInfo/, body: table }, ...healthyRoutes]),
    });
    expect(hira.status).toBe("pass");
    expect(formatVerification([hira])).toContain("true 로 바꾸고");
  });

  it("❗ 출력에 serviceKey 가 남지 않는다", async () => {
    const http = fakeHttp([{ match: /./, status: 401 }]);
    const out = formatVerification([await verifyHira({ ...baseOptions, http })]);
    expect(out).not.toContain("serviceKey=k");
  });
});