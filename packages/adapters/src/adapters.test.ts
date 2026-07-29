import { LeadOpsError, parseEnv, projectDepletion, RawCandidate } from "@leadops/core";
import { describe, expect, it } from "vitest";
import { parseDataGoKrJson } from "./dataGoKr";
import { mapFtcBrand } from "./ftc";
import { mapHiraItem, type HiraHospitalItem } from "./hira";
import { makeMockCandidate, MockSourceAdapter } from "./mock";
import { adapterFor, createSourceAdapters, unverifiedAdapters } from "./registry";

const envelope = (body: unknown, resultCode = "00"): string =>
  JSON.stringify({ response: { header: { resultCode, resultMsg: "OK" }, body } });

describe("parseDataGoKrJson — 포털 응답 정규화", () => {
  it("정상 배열 응답을 읽는다", () => {
    const out = parseDataGoKrJson<{ a: number }>(
      envelope({ items: { item: [{ a: 1 }, { a: 2 }] }, pageNo: 1, numOfRows: 10, totalCount: 2 }),
      "u",
    );
    expect(out.items).toEqual([{ a: 1 }, { a: 2 }]);
    expect(out.totalCount).toBe(2);
  });

  it("결과가 1건이면 item 이 객체로 오는 경우를 배열로 정규화한다", () => {
    const out = parseDataGoKrJson<{ a: number }>(
      envelope({ items: { item: { a: 1 } }, totalCount: 1 }),
      "u",
    );
    expect(out.items).toEqual([{ a: 1 }]);
  });

  it("결과가 0건이면 items 가 빈 문자열로 온다", () => {
    const out = parseDataGoKrJson(envelope({ items: "", totalCount: 0 }), "u");
    expect(out.items).toEqual([]);
    expect(out.totalCount).toBe(0);
  });

  it("❗ resultCode 는 00 인데 body 가 없으면 fail-open 하지 않고 던진다", () => {
    // 이전 구현은 빈 결과로 넘겼다. 그러면 포털 장애가 "이 업종 업체 0개" 로 둔갑한다.
    expect(() => parseDataGoKrJson(envelope(undefined), "u")).toThrowError(/body 가 없습니다/);
  });

  it("❗ header 가 없는 응답도 던진다", () => {
    expect(() => parseDataGoKrJson(JSON.stringify({ response: { body: { items: "" } } }), "u")).toThrowError(
      /header\.resultCode 가 없습니다/,
    );
  });

  it("정상적으로 0건인 응답과 고장난 응답을 구분한다", () => {
    // items: "" 는 정상적인 0건이다 — 이건 던지면 안 된다.
    expect(parseDataGoKrJson(envelope({ items: "", totalCount: 0 }), "u").items).toEqual([]);
  });

  it("문자열로 온 숫자 필드를 정수로 바꾼다", () => {
    const out = parseDataGoKrJson(envelope({ items: "", pageNo: "3", numOfRows: "10", totalCount: "1234" }), "u");
    expect(out.totalCount).toBe(1234);
    expect(out.pageNo).toBe(3);
  });

  it("resultCode 가 00 이 아니면 던진다", () => {
    expect(() => parseDataGoKrJson(envelope({ items: "" }, "30"), "u")).toThrowError(/공공데이터포털 오류 30/);
  });

  it("트래픽 초과(22)는 재시도 가능으로 표시한다", () => {
    try {
      parseDataGoKrJson(envelope({ items: "" }, "22"), "u");
      expect.unreachable();
    } catch (e) {
      expect((e as LeadOpsError).retryable).toBe(true);
    }
  });

  it("키 오류(30)는 재시도하지 않는다", () => {
    try {
      parseDataGoKrJson(envelope({ items: "" }, "30"), "u");
      expect.unreachable();
    } catch (e) {
      expect((e as LeadOpsError).retryable).toBe(false);
    }
  });

  it("XML 오류 응답을 parse_error 로 바꾸고 원문 앞부분을 남긴다", () => {
    try {
      parseDataGoKrJson('<OpenAPI_ServiceResponse><cmmMsgHeader>...', "https://x");
      expect.unreachable();
    } catch (e) {
      expect((e as LeadOpsError).code).toBe("parse_error");
      expect(String((e as LeadOpsError).details["head"])).toContain("OpenAPI_ServiceResponse");
    }
  });
});

describe("mapHiraItem", () => {
  const item: HiraHospitalItem = {
    ykiho: "JDQ4MTg4MSM1MSMkMSMkMCMkODkkMzgxMzUxIzExIyQxIyQ2IyQ4MyQzNzExMzEjNjEjJDEjJDgjJDgz",
    yadmNm: "강남테스트피부과의원",
    clCd: "31",
    sidoCdNm: "서울",
    sgguCdNm: "강남구",
    emdongNm: "역삼동",
    addr: "서울특별시 강남구 테헤란로 1",
    telno: "02-1234-5678",
    hospUrl: "https://example-derm.kr",
    drTotCnt: "3",
    XPos: "127.03",
    YPos: "37.50",
  };

  it("필수 필드를 매핑한다", () => {
    const out = mapHiraItem(item, "derm", "hira_hospital")!;
    expect(out.name).toBe("강남테스트피부과의원");
    expect(out.regionSigungu).toBe("강남구");
    expect(out.phone).toBe("02-1234-5678");
    expect(out.homepageUrl).toBe("https://example-derm.kr");
    expect(out.sizeSignals).toEqual({ doctorCount: 3 });
    expect(out.lat).toBeCloseTo(37.5);
    expect(out.lng).toBeCloseTo(127.03);
  });

  it("도메인 스키마를 만족한다", () => {
    expect(() => RawCandidate.parse(mapHiraItem(item, "derm", "hira_hospital"))).not.toThrow();
  });

  it("❗ 매핑 결과에 이메일 필드가 없다 (정보통신망법 제50조의2)", () => {
    const out = mapHiraItem(item, "derm", "hira_hospital")!;
    expect(out.publicApiEmail).toBeUndefined();
    expect(Object.keys(out)).not.toContain("email");
  });

  it("식별자나 이름이 없으면 버린다", () => {
    expect(mapHiraItem({ yadmNm: "이름만" }, "derm", "s")).toBeNull();
    expect(mapHiraItem({ ykiho: "id만" }, "derm", "s")).toBeNull();
  });

  it("빈 문자열 필드를 undefined 로 만든다 (빈 값 저장 방지)", () => {
    const out = mapHiraItem({ ykiho: "a", yadmNm: "b", telno: "  ", hospUrl: "" }, "dental", "s")!;
    expect(out.phone).toBeUndefined();
    expect(out.homepageUrl).toBeUndefined();
  });
});

describe("mapFtcBrand", () => {
  it("브랜드를 후보로 바꾸고 사업자번호에서 숫자만 남긴다", () => {
    const out = mapFtcBrand(
      {
        brandMgtNo: "B-001",
        brandNm: "테스트커피",
        jnghdqrtrsNm: "테스트에프앤비(주)",
        bizrno: "123-45-67890",
        corpno: "110111-1234567",
        hdoffAddr: "서울 강남구",
        hpageUrl: "https://testcoffee.kr",
        reprsntNm: "홍길동",
      },
      "ftc_franchise",
    )!;
    expect(out.name).toBe("테스트커피");
    expect(out.bizNo).toBe("1234567890");
    expect(out.corpNo).toBe("1101111234567");
    expect(out.industry).toBe("franchise");
  });

  it("❗ 대표자명(개인정보)을 후보에 담지 않는다", () => {
    const out = mapFtcBrand({ brandMgtNo: "B-1", brandNm: "X", reprsntNm: "홍길동" }, "s")!;
    const serialized = JSON.stringify({ ...out, raw: undefined });
    expect(serialized).not.toContain("홍길동");
  });

  it("브랜드명이 없으면 본부명을 쓴다", () => {
    expect(mapFtcBrand({ brandMgtNo: "B-2", jnghdqrtrsNm: "본부만(주)" }, "s")!.name).toBe("본부만(주)");
  });

  it("관리번호가 없으면 버린다", () => {
    expect(mapFtcBrand({ brandNm: "이름만" }, "s")).toBeNull();
  });
});

describe("MockSourceAdapter", () => {
  const adapter = new MockSourceAdapter();

  it("모집단 수를 돌려준다", async () => {
    const u = await adapter.countUniverse("dental");
    expect(u.total).toBe(19_300);
    expect(u.note).toContain("목업");
  });

  it("limit 만큼 후보를 만든다", async () => {
    const out: unknown[] = [];
    for await (const c of adapter.fetchCandidates("derm", { limit: 7 })) out.push(c);
    expect(out).toHaveLength(7);
  });

  it("결정적이다 — 같은 인덱스는 같은 결과", () => {
    expect(makeMockCandidate("derm", 3)).toEqual(makeMockCandidate("derm", 3));
  });

  it("생성한 후보가 도메인 스키마를 만족한다", async () => {
    for await (const c of adapter.fetchCandidates("franchise", { limit: 5 })) {
      expect(() => RawCandidate.parse(c)).not.toThrow();
    }
  });

  it("❗ 목업도 이메일을 만들지 않는다", async () => {
    for await (const c of adapter.fetchCandidates("derm", { limit: 20 })) {
      expect(c.publicApiEmail).toBeUndefined();
    }
  });

  it("verifiedAgainstLiveApi 는 항상 false", () => {
    expect(adapter.verifiedAgainstLiveApi).toBe(false);
  });

  it("❗ production 런타임에서는 생성 자체가 거부된다 (env 검증의 2차 방어선)", () => {
    const original = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(() => new MockSourceAdapter()).toThrowError(/production 에서 사용할 수 없습니다/);
    } finally {
      process.env["NODE_ENV"] = original;
    }
  });
});

describe("createSourceAdapters", () => {
  const fakeHttp = {} as never;

  it("mock 모드면 목업 어댑터만 준다", () => {
    const env = parseEnv({ NODE_ENV: "development", FEATURE_SOURCE: "mock" });
    const adapters = createSourceAdapters(env, fakeHttp);
    expect(adapters.map((a) => a.sourceName)).toEqual(["mock"]);
  });

  it("live 모드면 실 어댑터를 준다", () => {
    const env = parseEnv({
      NODE_ENV: "development",
      FEATURE_SOURCE: "live",
      DATA_GO_KR_SERVICE_KEY: "test-key",
    });
    const adapters = createSourceAdapters(env, fakeHttp);
    expect(adapters.map((a) => a.sourceName)).toEqual(["hira_hospital", "ftc_franchise"]);
  });

  it("업종을 담당하는 어댑터를 고른다", () => {
    const env = parseEnv({
      NODE_ENV: "development",
      FEATURE_SOURCE: "live",
      DATA_GO_KR_SERVICE_KEY: "k",
    });
    const adapters = createSourceAdapters(env, fakeHttp);
    expect(adapterFor(adapters, "dental").sourceName).toBe("hira_hospital");
    expect(adapterFor(adapters, "franchise").sourceName).toBe("ftc_franchise");
  });

  it("담당 어댑터가 없으면 조용히 넘어가지 않고 던진다", () => {
    expect(() => adapterFor([new MockSourceAdapter()].slice(0, 0), "derm")).toThrowError(/어댑터가 없습니다/);
  });

  it("미검증 어댑터를 보고한다", () => {
    const env = parseEnv({
      NODE_ENV: "development",
      FEATURE_SOURCE: "live",
      DATA_GO_KR_SERVICE_KEY: "k",
    });
    expect(unverifiedAdapters(createSourceAdapters(env, fakeHttp))).toEqual(["hira_hospital", "ftc_franchise"]);
  });
});

describe("projectDepletion — 모집단 소진 (설계서 결론 D)", () => {
  it("U=30,000 · 신규 280/일 이면 약 107 영업일", () => {
    const p = projectDepletion(30_000, 280);
    expect(p.newExhaustionBusinessDays).toBe(108);
    expect(p.newExhaustionMonths).toBeCloseTo(4.9, 1);
  });

  it("소진일은 신규 처리량에 반비례한다", () => {
    expect(projectDepletion(10_000, 400).newExhaustionBusinessDays).toBe(25);
    expect(projectDepletion(10_000, 100).newExhaustionBusinessDays).toBe(100);
  });

  it("신규 처리량이 0 이면 거부한다", () => {
    expect(() => projectDepletion(1000, 0)).toThrow();
  });
});
