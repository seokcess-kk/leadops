import type { Industry, RawCandidate, UniverseCount } from "@leadops/core";

/**
 * 데이터 소스 어댑터 계약.
 *
 * 설계서 1.6절 "데이터 소스는 교체 가능한 어댑터로 분리한다".
 *
 * 구현체는 다음을 지켜야 한다:
 *  - `sourceName` 이 `source_registry` 에 등록되어 있고 승인 상태여야 한다.
 *    (`assertSourceApproved()` 를 생성자에서 호출)
 *  - 실제 키가 없으면 **명확한 에러로 실패**한다. mock 으로 조용히 폴백하지 않는다.
 *  - 이메일을 홈페이지에서 추출하지 않는다. 공공 API 가 **필드로** 주는 경우에만
 *    `publicApiEmail` / `publicApiEmailSource` 를 채운다.
 */
export interface SourceAdapter {
  readonly sourceName: string;
  readonly supportedIndustries: readonly Industry[];

  /**
   * 이 어댑터가 실제 API 응답으로 검증되었는지.
   *
   * `false` 면 스파이크·워커가 경고를 남긴다. 실키로 한 번이라도 통과하면
   * 테스트 fixture 를 커밋하고 `true` 로 바꾼다.
   * 검증되지 않은 어댑터의 결과를 "완료"로 취급하지 않기 위한 표시다.
   */
  readonly verifiedAgainstLiveApi: boolean;

  /** 모집단 크기 실측 (설계서 M0). 페이지 1 의 totalCount 만 읽으므로 저렴하다. */
  countUniverse(industry: Industry): Promise<UniverseCount>;

  /** 후보를 페이지 단위로 흘려보낸다. */
  fetchCandidates(industry: Industry, options: FetchCandidatesOptions): AsyncIterable<RawCandidate>;
}

export interface FetchCandidatesOptions {
  /** 최대 반환 개수. 스파이크에서 표본을 뽑을 때 쓴다. */
  limit?: number;
  /** 시·도 코드 등 소스별 필터. */
  regionCode?: string;
  /** 페이지 크기. 기본 100. */
  pageSize?: number;
}

export class AdapterNotConfiguredError extends Error {
  constructor(source: string, missing: string) {
    super(`${source} 어댑터를 사용할 수 없습니다: ${missing} 가 설정되지 않았습니다`);
    this.name = "AdapterNotConfiguredError";
  }
}
