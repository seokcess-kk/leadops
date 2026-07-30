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
 * ✅ 검증 상태: **검증됨** (`verifiedAgainstLiveApi = true`) — 2026-07-30 실키 실행
 *
 *   · ENDPOINT 정상 동작
 *   · 응답 필드 전부 존재: ykiho, yadmNm, addr, telno, hospUrl, sgguCdNm,
 *     drTotCnt, XPos, YPos → mapHiraItem 이 그대로 동작한다
 *   · **hospUrl 이 실제로 온다** — 홈페이지 URL 을 검색 없이 확보할 수 있다
 *   · 코드값: dgsbjtCd 14(피부과)·08(성형외과), clCd 31(의원)·51(치과의원)
 *     → 공식 가이드 문서와 실측 전수 카운트가 일치한다
 *   · 응답을 `fixtures/http/` 에 녹화해 회귀 테스트 입력으로 쓴다
 *
 *   재현: `pnpm spike verify`
 *
 * 📄 스펙 출처: `OpenAPI활용가이드_건강보험심사평가원(병원정보서비스)_210616.docx`
 *    (data.go.kr 활용신청 상세에서 배포)
 *
 * ❗ 가이드 문서는 `hospInfoService1/getHospBasisList1` (2021년판)을 적고 있지만,
 *    우리는 `hospInfoServicev2/getHospBasisList` 를 쓴다. 실키 검증에서 v2 가 정상
 *    응답하고 필드도 동일하다. 후보 탐색이 v2 를 먼저 찾으므로 그대로 둔다 —
 *    v2 가 죽으면 `pnpm spike verify` 가 v1 로 넘어가 알려준다.
 */

const ENDPOINT = "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList";

/**
 * 수집 범위 (`HIRA_SCOPE`) — **이 값이 모집단을 10배 바꾼다.**
 *
 * | scope | 피부과 | 성형외과 | 뜻 |
 * |---|---:|---:|---|
 * | `name` (기본) | 1,555 | 1,236 | 기관명에 과목명이 든 곳 — 그 과를 **표방하는** 의원 |
 * | `specialty` | 16,987 | 4,883 | 그 과목을 **신고한** 곳 — 피부 시술 겸하는 일반의원 포함 |
 *
 * 발주자 결정(2026-07-30): **`name`**. 피부과 신고는 전체 의원의 45%가 하고 있어
 * `specialty` 로 모으면 "피부과 마케팅" 이 맞지 않는 일반의원이 대량 섞인다.
 *
 * 되돌릴 수 있도록 **설정값**으로 둔다 (`settings.collection.hira_scope`).
 * 코드를 고치지 않고 넓힐 수 있어야 한다.
 */
export type HiraScope = "name" | "specialty";
export const DEFAULT_HIRA_SCOPE: HiraScope = "name";

/**
 * `scope = 'name'` 에서 기관명에 요구하는 키워드.
 *
 * 실측(2026-07-30): `피부` 로 넓히면 1,559곳(+4), `성형` 은 1,237곳(+1)이다.
 * 차이가 무의미하므로 과목명 그대로 쓴다 — 짧은 키워드는 오탐 위험만 늘린다.
 * 이름에 두 과목이 다 든 의원은 2곳뿐이라 업종 간 중복은 무시할 수준이다.
 */
export const NAME_KEYWORD = { derm: "피부과", plastic: "성형외과", dental: "치과" } as const;

/**
 * 진료과목 코드표 — **공식 가이드 문서 전재**.
 *
 * 출처: `OpenAPI활용가이드_건강보험심사평가원(병원정보서비스)_210616.docx`
 * (data.go.kr 활용신청 상세에서 배포. 2021-06-16판) 요청 메시지 명세의 `dgsbjtCd` 항목.
 *
 * ❗ 추측이 아니라 문서다. 그리고 실측과 일치한다 —
 *    14=피부과·08=성형외과는 이름 → 코드 전수 카운트에서 99.9%·99.8%로 확인됐다.
 *
 * 업종을 늘릴 때 여기서 고른다 (예: 안과 12, 한의원은 종별 93).
 */
export const HIRA_DGSBJT_NAMES: Readonly<Record<string, string>> = {
  "00": "일반의", "01": "내과", "02": "신경과", "03": "정신건강의학과",
  "04": "외과", "05": "정형외과", "06": "신경외과", "07": "흉부외과",
  "08": "성형외과", "09": "마취통증의학과", "10": "산부인과", "11": "소아청소년과",
  "12": "안과", "13": "이비인후과", "14": "피부과", "15": "비뇨의학과",
  "16": "영상의학과", "17": "방사선종양학과", "18": "병리과", "19": "진단검사의학과",
  "20": "결핵과", "21": "재활의학과", "22": "핵의학과", "23": "가정의학과",
  "24": "응급의학과", "25": "직업환경의학과", "26": "예방의학과",
  "50": "구강악안면외과", "51": "치과보철과", "52": "치과교정과", "53": "소아치과",
  "54": "치주과", "55": "치과보존과", "56": "구강내과", "57": "영상치의학과",
  "58": "구강병리과", "59": "예방치과", "61": "통합치의학과",
  "80": "한방내과", "81": "한방부인과", "82": "한방소아과",
  "83": "한방안이비인후피부과", "84": "한방신경정신과", "85": "침구과",
};

/** 종별(기관 종류) 코드표. 같은 가이드 문서의 `clCd` 항목. */
export const HIRA_CL_NAMES: Readonly<Record<string, string>> = {
  "01": "상급종합병원", "11": "종합병원", "21": "병원", "28": "요양병원",
  "29": "정신병원", "31": "의원", "41": "치과병원", "51": "치과의원",
  "61": "조산원", "71": "보건소", "72": "보건지소", "73": "보건진료소",
  "75": "보건의료원", "92": "한방병원", "93": "한의원",
};

export const HIRA_CODES = {
  /**
   * 진료과목: 피부과 — ✅ **확정** (문서 + 실측 이중 확인)
   *
   *  1. 공식 가이드 문서가 `14: 피부과` 로 명시한다 (`HIRA_DGSBJT_NAMES` 참고).
   *  2. 이름에 '피부과' 가 든 의원 **1,555곳 중 1,553곳(99.9%)** 이 이 코드를 신고했다.
   *     `totalCount` 끼리의 비교라 표본 오차가 없다 (2026-07-30 실키).
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
   * 진료과목: 성형외과 — ✅ **확정** (문서 + 실측 이중 확인)
   *
   * 가이드 문서가 `08: 성형외과` 로 명시하고, 이름에 '성형외과' 가 든 의원
   * **1,236곳 중 1,233곳(99.8%)** 이 이 코드를 신고했다.
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

  /**
   * 업종을 HIRA 질의 파라미터로 옮긴다.
   *
   * `scope` 가 모집단을 10배 바꾼다 — `HIRA_SCOPE` 주석 참고.
   */
  #paramsFor(industry: Industry, scope: HiraScope): Record<string, string> {
    switch (industry) {
      case "derm":
        return scope === "name"
          ? { yadmNm: NAME_KEYWORD.derm, clCd: HIRA_CODES.cl_clinic }
          : { dgsbjtCd: HIRA_CODES.dgsbjt_derm, clCd: HIRA_CODES.cl_clinic };
      case "plastic":
        return scope === "name"
          ? { yadmNm: NAME_KEYWORD.plastic, clCd: HIRA_CODES.cl_clinic }
          : { dgsbjtCd: HIRA_CODES.dgsbjt_plastic, clCd: HIRA_CODES.cl_clinic };
      case "dental":
        // 치과는 **종별** 코드다. 기관 종류이므로 이름이 곧 종류이고(실측 100%),
        // scope 를 나눌 이유가 없다.
        return { clCd: HIRA_CODES.cl_dental_clinic };
      case "franchise":
        throw new Error("HIRA 어댑터는 프랜차이즈를 지원하지 않습니다");
      default: {
        const never: never = industry;
        throw new Error(`알 수 없는 업종: ${String(never)}`);
      }
    }
  }

  async countUniverse(industry: Industry, options: { scope?: HiraScope } = {}): Promise<UniverseCount> {
    const env = await this.#client.get<HiraHospitalItem>({
      endpoint: ENDPOINT,
      params: { ...this.#paramsFor(industry, options.scope ?? DEFAULT_HIRA_SCOPE), pageNo: 1, numOfRows: 1 },
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
    const base = this.#paramsFor(industry, options.scope ?? DEFAULT_HIRA_SCOPE);

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
