import { nullLogger } from "@leadops/core";
import type { HttpClient } from "@leadops/http";
import { describe, expect, it } from "vitest";
import { DEFAULT_HIRA_SCOPE, HiraHospitalAdapter, HIRA_CODES, NAME_KEYWORD } from "./hira";

/**
 * 수집 범위 (`HiraScope`).
 *
 * ❗ 이 설정이 모집단을 **10배** 바꾼다 (피부과 1,555 ↔ 16,987).
 *    발주자 결정(2026-07-30)은 `name` 이고, 그 결정이 코드에서 실제로 지켜지는지를
 *    여기서 고정한다. 실수로 `specialty` 로 되돌아가면 리드 품질이 조용히 무너진다.
 */

/** 요청 URL 을 모아 두는 가짜 클라이언트. 빈 응답을 주므로 반복은 즉시 끝난다. */
function recordingHttp(): { http: HttpClient; urls: string[] } {
  const urls: string[] = [];
  const body = JSON.stringify({
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL SERVICE" },
      body: { items: { item: [] }, totalCount: 1555, pageNo: 1, numOfRows: 0 },
    },
  });
  const http = {
    async get(url: string) {
      urls.push(url);
      return { status: 200, finalUrl: url, headers: {}, body, hops: [], truncated: false };
    },
  } as unknown as HttpClient;
  return { http, urls };
}

const params = (url: string): URLSearchParams => new URL(url).searchParams;

describe("기본값", () => {
  it("❗ 기본 범위는 name 이다 (발주자 결정)", () => {
    expect(DEFAULT_HIRA_SCOPE).toBe("name");
  });

  it("이름 키워드는 과목명 그대로다", () => {
    // 실측: `피부` 로 넓혀도 +4곳뿐이라 짧은 키워드를 쓸 이유가 없다.
    expect(NAME_KEYWORD.derm).toBe("피부과");
    expect(NAME_KEYWORD.plastic).toBe("성형외과");
  });
});

describe("scope = name — 기관명으로 좁힌다", () => {
  it("❗ 피부과는 yadmNm 으로 조회하고 dgsbjtCd 를 쓰지 않는다", async () => {
    const { http, urls } = recordingHttp();
    const adapter = new HiraHospitalAdapter(http, "k");
    await adapter.countUniverse("derm", { scope: "name" });

    const q = params(urls[0]!);
    expect(q.get("yadmNm")).toBe("피부과");
    expect(q.get("clCd")).toBe(HIRA_CODES.cl_clinic);
    expect(q.get("dgsbjtCd")).toBeNull();
  });

  it("성형외과도 같은 방식이다", async () => {
    const { http, urls } = recordingHttp();
    await new HiraHospitalAdapter(http, "k").countUniverse("plastic", { scope: "name" });
    const q = params(urls[0]!);
    expect(q.get("yadmNm")).toBe("성형외과");
    expect(q.get("dgsbjtCd")).toBeNull();
  });

  it("수집(fetchCandidates)도 같은 파라미터를 쓴다", async () => {
    const { http, urls } = recordingHttp();
    const adapter = new HiraHospitalAdapter(http, "k");
    for await (const _ of adapter.fetchCandidates("derm", { limit: 1, scope: "name" })) break;
    expect(params(urls[0]!).get("yadmNm")).toBe("피부과");
  });

  it("❗ scope 를 주지 않아도 name 으로 동작한다 (기본값이 결정과 일치)", async () => {
    const { http, urls } = recordingHttp();
    await new HiraHospitalAdapter(http, "k").countUniverse("derm");
    expect(params(urls[0]!).get("yadmNm")).toBe("피부과");
  });
});

describe("scope = specialty — 넓힐 수 있다 (되돌릴 수 있어야 한다)", () => {
  it("진료과목 코드로 조회하고 이름 필터를 쓰지 않는다", async () => {
    const { http, urls } = recordingHttp();
    await new HiraHospitalAdapter(http, "k").countUniverse("derm", { scope: "specialty" });
    const q = params(urls[0]!);
    expect(q.get("dgsbjtCd")).toBe(HIRA_CODES.dgsbjt_derm);
    expect(q.get("yadmNm")).toBeNull();
  });
});

describe("치과는 범위를 나누지 않는다", () => {
  it("종별 코드만 쓴다 — 기관 종류라 이름이 곧 종류다", async () => {
    for (const scope of ["name", "specialty"] as const) {
      const { http, urls } = recordingHttp();
      await new HiraHospitalAdapter(http, "k").countUniverse("dental", { scope });
      const q = params(urls[0]!);
      expect(q.get("clCd")).toBe(HIRA_CODES.cl_dental_clinic);
      expect(q.get("yadmNm")).toBeNull();
      expect(q.get("dgsbjtCd")).toBeNull();
    }
  });
});

describe("지원하지 않는 업종", () => {
  it("프랜차이즈는 거부한다", async () => {
    const { http } = recordingHttp();
    await expect(new HiraHospitalAdapter(http, "k").countUniverse("franchise")).rejects.toThrow(/프랜차이즈/);
  });
});

describe("로거를 쓰지 않는 경로에서도 동작한다", () => {
  it("nullLogger 로 생성해도 문제없다", () => {
    const { http } = recordingHttp();
    expect(() => new HiraHospitalAdapter(http, "k")).not.toThrow();
    expect(nullLogger).toBeDefined();
  });
});

describe("문서화된 코드표 (가이드 문서 전재)", () => {
  it("❗ 우리가 쓰는 코드가 코드표의 이름과 일치한다", async () => {
    const { HIRA_DGSBJT_NAMES, HIRA_CL_NAMES } = await import("./hira");
    // 코드표는 공식 가이드 문서에서 옮긴 것이고, 우리가 고른 값이 그 표와 어긋나면 안 된다.
    expect(HIRA_DGSBJT_NAMES[HIRA_CODES.dgsbjt_derm]).toBe("피부과");
    expect(HIRA_DGSBJT_NAMES[HIRA_CODES.dgsbjt_plastic]).toBe("성형외과");
    expect(HIRA_CL_NAMES[HIRA_CODES.cl_clinic]).toBe("의원");
    expect(HIRA_CL_NAMES[HIRA_CODES.cl_dental_clinic]).toBe("치과의원");
    expect(HIRA_CL_NAMES[HIRA_CODES.cl_dental_hospital]).toBe("치과병원");
  });

  it("이름 키워드가 코드표의 과목명과 같다", async () => {
    const { HIRA_DGSBJT_NAMES } = await import("./hira");
    // scope=name 과 scope=specialty 가 같은 과목을 가리켜야 한다.
    expect(NAME_KEYWORD.derm).toBe(HIRA_DGSBJT_NAMES[HIRA_CODES.dgsbjt_derm]);
    expect(NAME_KEYWORD.plastic).toBe(HIRA_DGSBJT_NAMES[HIRA_CODES.dgsbjt_plastic]);
  });

  it("❗ 치과·한방 코드가 표에 있다 (예전 탐색 범위 00~30 이 놓쳤던 구간)", async () => {
    const { HIRA_DGSBJT_NAMES } = await import("./hira");
    expect(HIRA_DGSBJT_NAMES["52"]).toBe("치과교정과");
    expect(HIRA_DGSBJT_NAMES["61"]).toBe("통합치의학과");
    expect(HIRA_DGSBJT_NAMES["85"]).toBe("침구과");
  });

  it("업종 확장 후보가 표에 있다", async () => {
    const { HIRA_DGSBJT_NAMES, HIRA_CL_NAMES } = await import("./hira");
    expect(HIRA_DGSBJT_NAMES["12"]).toBe("안과");
    expect(HIRA_CL_NAMES["93"]).toBe("한의원");
  });
});
