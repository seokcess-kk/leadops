import { assertSourceApproved, CompanyStatus, type Industry, type RawCandidate, type UniverseCount } from "@leadops/core";
import type { HttpClient } from "@leadops/http";
import { DataGoKrClient } from "./dataGoKr";
import { AdapterNotConfiguredError, type FetchCandidatesOptions, type SourceAdapter } from "./types";

/**
 * 공정거래위원회 가맹정보 어댑터 (가맹본부·브랜드).
 *
 * 데이터셋:
 *  - 브랜드 목록          https://www.data.go.kr/data/15125467/openapi.do
 *  - 브랜드별 가맹점 현황  https://www.data.go.kr/data/15110241/openapi.do
 *
 * ⚠️ 검증 상태: **미검증** (`verifiedAgainstLiveApi = false`)
 *    엔드포인트 경로와 필드명이 확정되지 않았습니다. Phase 0 에서 실키로 확인하세요.
 *    엔드포인트는 아래 상수 하나만 고치면 되도록 모아 두었습니다.
 */

const ENDPOINTS = {
  brandList: "https://apis.data.go.kr/1130000/FftcBrandRegistrationService/getBrandRegistrationList",
  storeCount: "https://apis.data.go.kr/1130000/FftcBrandFrcsService/getBrandFrcsList",
} as const;

export interface FtcBrandItem {
  brandMgtNo?: string; // 브랜드 관리번호
  brandNm?: string; // 브랜드명
  hdoffMgtNo?: string; // 본부 관리번호
  jnghdqrtrsNm?: string; // 가맹본부명
  bizrno?: string; // 사업자등록번호
  corpno?: string; // 법인등록번호
  reprsntNm?: string; // 대표자명 (❗개인정보 — 저장하지 않는다)
  indutyNm?: string; // 업종명
  hdoffAddr?: string; // 본부 주소
  hdoffTelno?: string; // 본부 전화
  hpageUrl?: string; // 홈페이지
  bsnsBgnDe?: string; // 사업 개시일
}

export interface FtcStoreCountItem {
  brandMgtNo?: string;
  frcsCnt?: number | string; // 가맹점 수
  diracsCnt?: number | string; // 직영점 수
  yr?: string;
}

/** 가맹점 100개 이상은 기본 제외 (설계서 1.5절, 설정값). */
export const DEFAULT_FRANCHISE_STORE_LIMIT = 100;

export class FtcFranchiseAdapter implements SourceAdapter {
  readonly sourceName = "ftc_franchise";
  readonly supportedIndustries = ["franchise"] as const;
  // ⚠️ 실제 API 응답으로 검증되지 않았음.
  readonly verifiedAgainstLiveApi = false;

  readonly #client: DataGoKrClient;

  constructor(http: HttpClient, serviceKey: string | undefined) {
    assertSourceApproved(this.sourceName);
    if (!serviceKey) throw new AdapterNotConfiguredError(this.sourceName, "DATA_GO_KR_SERVICE_KEY");
    this.#client = new DataGoKrClient(http, serviceKey);
  }

  async countUniverse(industry: Industry): Promise<UniverseCount> {
    this.#assertSupported(industry);
    const env = await this.#client.get<FtcBrandItem>({
      endpoint: ENDPOINTS.brandList,
      params: { pageNo: 1, numOfRows: 1 },
    });
    return {
      industry,
      source: this.sourceName,
      total: env.totalCount,
      // 가맹점 100개 이상 제외는 별도 API 조인이 필요하므로 전수 조사 시에만 산출된다.
      eligible: null,
      measuredAt: new Date().toISOString(),
      note: this.verifiedAgainstLiveApi
        ? "브랜드 기준. 본부 기준으로 통합하면 더 적음"
        : "미검증 어댑터 — 엔드포인트 확인 필요",
    };
  }

  async *fetchCandidates(industry: Industry, options: FetchCandidatesOptions = {}): AsyncIterable<RawCandidate> {
    this.#assertSupported(industry);
    const pageSize = options.pageSize ?? 100;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;

    let emitted = 0;
    for (let pageNo = 1; emitted < limit; pageNo++) {
      const env = await this.#client.get<FtcBrandItem>({
        endpoint: ENDPOINTS.brandList,
        params: { pageNo, numOfRows: pageSize },
      });
      if (env.items.length === 0) return;

      for (const item of env.items) {
        if (emitted >= limit) return;
        const mapped = mapFtcBrand(item, this.sourceName);
        if (mapped) {
          emitted++;
          yield mapped;
        }
      }

      if (pageNo * pageSize >= env.totalCount) return;
    }
  }

  /** 브랜드별 가맹점 수를 조회한다. 제외 판정에 쓴다. */
  async fetchStoreCount(brandMgtNo: string): Promise<number | null> {
    const env = await this.#client.get<FtcStoreCountItem>({
      endpoint: ENDPOINTS.storeCount,
      params: { brandMgtNo, pageNo: 1, numOfRows: 10 },
    });
    // 여러 연도가 오면 가장 최근 것을 쓴다.
    const sorted = [...env.items].sort((a, b) => String(b.yr ?? "").localeCompare(String(a.yr ?? "")));
    const latest = sorted[0];
    if (!latest) return null;
    const n = Number(latest.frcsCnt);
    return Number.isFinite(n) ? n : null;
  }

  #assertSupported(industry: Industry): void {
    if (industry !== "franchise") {
      throw new Error(`FTC 어댑터는 '${industry}' 를 지원하지 않습니다`);
    }
  }
}

/**
 * FTC 브랜드 항목을 후보로 변환한다.
 *
 * ❗ `reprsntNm`(대표자명)은 개인정보이므로 후보에 담지 않는다.
 *    규모 판정·연락에 필요하지 않고, 담는 순간 보유기간·파기 의무가 따라온다.
 */
export function mapFtcBrand(item: FtcBrandItem, source: string): RawCandidate | null {
  const externalId = item.brandMgtNo?.trim();
  const brandName = item.brandNm?.trim();
  const hqName = item.jnghdqrtrsNm?.trim();
  if (!externalId || (!brandName && !hqName)) return null;

  return {
    source,
    externalId,
    industry: "franchise",
    // 통합 기준은 본부·법인이지만(설계서 1.5절), 표시명은 브랜드가 실무에 유용하다.
    name: brandName ?? hqName ?? "",
    ...(item.bizrno?.trim() ? { bizNo: item.bizrno.replace(/\D/g, "") } : {}),
    ...(item.corpno?.trim() ? { corpNo: item.corpno.replace(/\D/g, "") } : {}),
    ...(item.hdoffAddr?.trim() ? { address: item.hdoffAddr.trim() } : {}),
    ...(item.hdoffTelno?.trim() ? { phone: item.hdoffTelno.trim() } : {}),
    ...(item.hpageUrl?.trim() ? { homepageUrl: item.hpageUrl.trim() } : {}),
    status: CompanyStatus.parse("unknown"),
    sizeSignals: {},
    raw: item,
  };
}
