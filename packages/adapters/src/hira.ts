import {
  assertSourceApproved,
  CompanyStatus,
  type Industry,
  type RawCandidate,
  type UniverseCount,
} from "@leadops/core";
import type { HttpClient } from "@leadops/http";
import { DataGoKrClient } from "./dataGoKr";
import { AdapterNotConfiguredError, type FetchCandidatesOptions, type SourceAdapter } from "./types";

/**
 * 건강보험심사평가원 병원정보서비스 어댑터.
 *
 * 데이터셋: https://www.data.go.kr/data/15001698/openapi.do
 *
 * ⚠️ 검증 상태: **부분 검증** (`verifiedAgainstLiveApi = false`) — 2026-07-29 실키 실행
 *
 *   ✅ 확인됨
 *     · ENDPOINT 정상 동작
 *     · 응답 필드 전부 존재: ykiho, yadmNm, addr, telno, hospUrl, sgguCdNm,
 *       drTotCnt, XPos, YPos → mapHiraItem 이 그대로 동작한다
 *     · **hospUrl 이 실제로 온다** — 홈페이지 URL 을 검색 없이 확보할 수 있다
 *     · clCd=31(의원) 37,819건 / clCd=51(치과의원) 19,398건
 *
 *   ❌ 미해결
 *     · dgsbjt_derm = "14" 가 피부과인지 확인하지 못했다 (아래 참조)
 *
 *   재현: `pnpm spike verify`
 */

const ENDPOINT = "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList";

/**
 * 진료과목코드(dgsbjtCd)와 종별코드(clCd).
 *
 * ⚠️ 이 표는 **검증 대상**입니다. 틀리면 수집 자체가 빗나갑니다.
 *    `pnpm spike verify` 가 경험적으로 확인합니다 — 코드가 맞으면 반환된 기관명의
 *    80% 이상에 해당 키워드가 들어 있고, 틀리면 5% 미만입니다.
 */
export const HIRA_CODES = {
  /**
   * 진료과목: 피부과 — ✅ **확정** (2026-07-30 실키, 전수 카운트)
   *
   * 이름에 '피부과' 가 든 의원 **1,555곳 중 1,553곳(99.9%)** 이 `dgsbjtCd=14` 를 신고했다.
   * `totalCount` 끼리의 비교라 표본 오차가 없다.
   *
   * ❗ 이 값은 한때 "틀렸을 가능성이 높다" 고 기록돼 있었다. **코드가 아니라 검증 방법이
   *    틀렸다.** 코드 → 이름 방향(코드 14 로 거른 16,987건 중 이름에 '피부과' 가 몇 %인가)
   *    으로 재면 상승도가 1.0배로 나온다. 피부과는 **전체 의원의 45%(37,819 중 16,987)가
   *    신고하는 과목**이라 표본이 통째로 희석되기 때문이다. 실제로 성형외과 의원의 45.2%도
   *    피부과를 함께 신고한다.
   *
   * 교훈: 다대다 관계에서는 **희소한 쪽에서 물어야 한다.**
   */
  dgsbjt_derm: "14",

  /**
   * 진료과목: 성형외과 — ✅ **확정** (2026-07-30 실키, 전수 카운트)
   *
   * 이름에 '성형외과' 가 든 의원 **1,236곳 중 1,233곳(99.8%)** 이 `dgsbjtCd=08` 을 신고했다.
   * (2026-07-29 의 이름 상승도 10.3배 관측과도 일치한다.)
   */
  dgsbjt_plastic: "08",

  /**
   * 종별: 치과의원 — ✅ **확인됨**
   *
   * 실키 검증: 19,398건, 기관명에 '치과' 포함 **100%**.
   * HIRA 자체 검색 URL 과도 일치:
   *   srchClcd=41,01,21,11,51 & srchClcdNm=치과병원,상급종합,병원,종합병원,치과의원
   */
  cl_dental_clinic: "51",

  /** 종별: 치과병원 — 위 URL 에서 41 로 확인됨 (건수 검증은 미실시) */
  cl_dental_hospital: "41",

  /** 종별: 의원 — ✅ **확인됨**. 실키 검증에서 37,819건 (전국 의원 수와 정합) */
  cl_clinic: "31",
} as const;

/** HIRA 응답 항목. 문서상 필드명을 그대로 쓴다. */
export interface HiraHospitalItem {
  ykiho?: string; // 암호화된 요양기호 (1:1 매칭 식별자)
  yadmNm?: string; // 요양기관명
  clCd?: string; // 종별코드
  clCdNm?: string;
  sidoCd?: string;
  sidoCdNm?: string;
  sgguCd?: string;
  sgguCdNm?: string;
  emdongNm?: string;
  postNo?: string;
  addr?: string;
  telno?: string;
  hospUrl?: string; // 병원 홈페이지 (있는 경우)
  estbDd?: string; // 개설일자
  drTotCnt?: number | string; // 의사 총수
  XPos?: number | string; // 경도
  YPos?: number | string; // 위도
}

export class HiraHospitalAdapter implements SourceAdapter {
  readonly sourceName = "hira_hospital";
  readonly supportedIndustries = ["derm", "plastic", "dental"] as const;
  /**
   * ✅ **검증됨** (2026-07-30, `pnpm spike verify` 실키 실행)
   *
   * 엔드포인트 · 필수 필드(ykiho·yadmNm) · 선택 필드(addr·telno·**hospUrl**) ·
   * 진료과목 코드 14/08 · 종별 코드 51 이 모두 실응답으로 확인됐다.
   * 응답은 `fixtures/http/` 에 녹화돼 회귀 테스트 입력으로 쓰인다.
   */
  readonly verifiedAgainstLiveApi = true;

  readonly #client: DataGoKrClient;

  constructor(http: HttpClient, serviceKey: string | undefined) {
    assertSourceApproved(this.sourceName);
    if (!serviceKey) throw new AdapterNotConfiguredError(this.sourceName, "DATA_GO_KR_SERVICE_KEY");
    this.#client = new DataGoKrClient(http, serviceKey);
  }

  /** 업종을 HIRA 질의 파라미터로 옮긴다. */
  #paramsFor(industry: Industry): Record<string, string> {
    switch (industry) {
      case "derm":
        return { dgsbjtCd: HIRA_CODES.dgsbjt_derm, clCd: HIRA_CODES.cl_clinic };
      case "plastic":
        return { dgsbjtCd: HIRA_CODES.dgsbjt_plastic, clCd: HIRA_CODES.cl_clinic };
      case "dental":
        return { clCd: HIRA_CODES.cl_dental_clinic };
      case "franchise":
        throw new Error("HIRA 어댑터는 프랜차이즈를 지원하지 않습니다");
      default: {
        const never: never = industry;
        throw new Error(`알 수 없는 업종: ${String(never)}`);
      }
    }
  }

  async countUniverse(industry: Industry): Promise<UniverseCount> {
    const env = await this.#client.get<HiraHospitalItem>({
      endpoint: ENDPOINT,
      params: { ...this.#paramsFor(industry), pageNo: 1, numOfRows: 1 },
    });
    return {
      industry,
      source: this.sourceName,
      total: env.totalCount,
      // HIRA 는 폐업 기관을 목록에서 제외하므로 total 이 곧 영업 중 기관 수에 가깝다.
      // 다만 대형 제외는 후속 단계에서 적용되므로 여기서는 알 수 없다.
      eligible: null,
      measuredAt: new Date().toISOString(),
      ...(this.verifiedAgainstLiveApi ? {} : { note: "미검증 어댑터 — 진료과목·종별 코드값 확인 필요" }),
    };
  }

  async *fetchCandidates(industry: Industry, options: FetchCandidatesOptions = {}): AsyncIterable<RawCandidate> {
    const pageSize = options.pageSize ?? 100;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const base = this.#paramsFor(industry);

    let emitted = 0;
    for (let pageNo = 1; emitted < limit; pageNo++) {
      const env = await this.#client.get<HiraHospitalItem>({
        endpoint: ENDPOINT,
        params: {
          ...base,
          ...(options.regionCode ? { sidoCd: options.regionCode } : {}),
          pageNo,
          numOfRows: pageSize,
        },
      });
      if (env.items.length === 0) return;

      for (const item of env.items) {
        if (emitted >= limit) return;
        const mapped = mapHiraItem(item, industry, this.sourceName);
        if (mapped) {
          emitted++;
          yield mapped;
        }
      }

      if (pageNo * pageSize >= env.totalCount) return;
    }
  }
}

/** HIRA 항목을 도메인 후보로 변환한다. 식별자·이름이 없으면 버린다. */
export function mapHiraItem(item: HiraHospitalItem, industry: Industry, source: string): RawCandidate | null {
  const externalId = item.ykiho?.trim();
  const name = item.yadmNm?.trim();
  if (!externalId || !name) return null;

  const doctors = toNumber(item.drTotCnt);
  const lat = toNumber(item.YPos);
  const lng = toNumber(item.XPos);

  return {
    source,
    externalId,
    industry,
    name,
    ...(item.addr?.trim() ? { address: item.addr.trim() } : {}),
    ...(item.sidoCdNm?.trim() ? { regionSido: item.sidoCdNm.trim() } : {}),
    ...(item.sgguCdNm?.trim() ? { regionSigungu: item.sgguCdNm.trim() } : {}),
    ...(item.emdongNm?.trim() ? { regionDong: item.emdongNm.trim() } : {}),
    ...(item.telno?.trim() ? { phone: item.telno.trim() } : {}),
    ...(item.hospUrl?.trim() ? { homepageUrl: item.hospUrl.trim() } : {}),
    ...(lat !== undefined ? { lat } : {}),
    ...(lng !== undefined ? { lng } : {}),
    // HIRA 목록에 있다는 것은 현재 운영 중이라는 뜻이지만, 반영 지연이 있으므로
    // 국세청 상태조회로 다시 확인하기 전까지는 unknown 이 아니라 active 로 두되
    // 출처를 남긴다. 최종 판정은 exclude_basic 스테이지의 몫이다.
    status: CompanyStatus.parse("active"),
    sizeSignals: doctors !== undefined ? { doctorCount: doctors } : {},
    // ❗ 이메일 필드 없음 — HIRA 는 이메일을 제공하지 않고,
    //    홈페이지에서 추출하지도 않는다 (정보통신망법 제50조의2).
    raw: item,
  };
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
