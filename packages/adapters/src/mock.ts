import { CompanyStatus, policyViolation, type Industry, type RawCandidate, type UniverseCount } from "@leadops/core";
import type { FetchCandidatesOptions, SourceAdapter } from "./types";

/**
 * 오프라인 개발·테스트용 목업 어댑터.
 *
 * ❗ `FEATURE_SOURCE=mock` 일 때만 등록된다. `NODE_ENV=production` 에서는
 *    환경변수 검증이 부팅을 막으므로(packages/core/src/env.ts) 프로덕션에 새어 나가지 않는다.
 *
 * 결정적(deterministic)으로 생성한다. 같은 입력 → 같은 출력이어야 테스트가 안정적이다.
 */

const UNIVERSE: Record<Industry, number> = {
  derm: 1_450,
  plastic: 1_120,
  dental: 19_300,
  franchise: 8_700,
};

const REGIONS: ReadonlyArray<[string, string]> = [
  ["서울특별시", "강남구"],
  ["서울특별시", "서초구"],
  ["부산광역시", "해운대구"],
  ["대구광역시", "수성구"],
  ["경기도", "성남시 분당구"],
];

const NAME_STEM: Record<Industry, string> = {
  derm: "피부과의원",
  plastic: "성형외과의원",
  dental: "치과의원",
  franchise: "브랜드",
};

export class MockSourceAdapter implements SourceAdapter {
  readonly sourceName = "mock";
  readonly supportedIndustries = ["derm", "plastic", "dental", "franchise"] as const;
  /** 목업은 실 API 를 대표하지 않는다. 항상 false. */
  readonly verifiedAgainstLiveApi = false;

  constructor() {
    // 2차 방어선. env 검증(packages/core/src/env.ts)이 이미 막지만, NODE_ENV 가
    // 누락된 채 배포되면 기본값(development + mock)으로 조용히 부팅될 수 있다.
    // 목업 자체가 프로덕션 런타임을 거부하게 해 둔다.
    if (process.env["NODE_ENV"] === "production") {
      throw policyViolation("MockSourceAdapter 는 production 에서 사용할 수 없습니다", {
        nodeEnv: "production",
      });
    }
  }

  async countUniverse(industry: Industry): Promise<UniverseCount> {
    return {
      industry,
      source: this.sourceName,
      total: UNIVERSE[industry],
      eligible: Math.round(UNIVERSE[industry] * 0.82),
      measuredAt: new Date().toISOString(),
      note: "목업 데이터 — 실제 모집단이 아님",
    };
  }

  async *fetchCandidates(industry: Industry, options: FetchCandidatesOptions = {}): AsyncIterable<RawCandidate> {
    const limit = Math.min(options.limit ?? 50, UNIVERSE[industry]);
    for (let i = 0; i < limit; i++) {
      yield makeMockCandidate(industry, i);
    }
  }
}

export function makeMockCandidate(industry: Industry, index: number): RawCandidate {
  const region = REGIONS[index % REGIONS.length]!;
  const seq = index + 1;
  const hasHomepage = index % 4 !== 3; // 75% 가 홈페이지를 가진 것으로 가정

  return {
    source: "mock",
    externalId: `mock-${industry}-${String(seq).padStart(5, "0")}`,
    industry,
    name: `${region[1]}${NAME_STEM[industry]}${seq}`,
    ...(industry === "franchise" ? { bizNo: `1${String(100000000 + index)}` } : {}),
    address: `${region[0]} ${region[1]} 테스트로 ${seq}`,
    regionSido: region[0],
    regionSigungu: region[1],
    phone: `02-${String(1000 + (index % 9000))}-${String(1000 + ((index * 7) % 9000))}`,
    ...(hasHomepage ? { homepageUrl: `https://mock-${industry}-${seq}.example.kr` } : {}),
    status: CompanyStatus.parse(index % 20 === 19 ? "closed" : "active"),
    sizeSignals:
      industry === "franchise"
        ? { storeCount: (index * 13) % 260 } // 일부는 100개 이상 → 제외 대상
        : { doctorCount: 1 + (index % 6) },
    // ❗ publicApiEmail 을 채우지 않는다. 목업이라도 이메일 흐름을 흉내 내지 않는다.
    //    이메일은 검수자 수동 입력으로만 들어온다 (설계서 결론 A).
    raw: { mock: true, index },
  };
}
