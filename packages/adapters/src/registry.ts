import { configError, type Env, type Industry } from "@leadops/core";
import type { HttpClient } from "@leadops/http";
import { FtcFranchiseAdapter } from "./ftc";
import { HiraHospitalAdapter } from "./hira";
import { MockSearchAdapter, MockSourceAdapter } from "./mock";
import { NaverSearchAdapter } from "./search";
import type { SearchAdapter } from "./search";
import type { SourceAdapter } from "./types";

/**
 * 어댑터 팩토리.
 *
 * 설계서 11장 "실데이터 미준비 부분의 처리 원칙":
 *  - live 모드에서 키가 없으면 **명확한 에러로 실패**한다. mock 으로 폴백하지 않는다.
 *  - mock 모드는 `FEATURE_SOURCE=mock` 일 때만. production 은 env 검증이 이미 막았다.
 */
export function createSourceAdapters(env: Env, http: HttpClient): SourceAdapter[] {
  if (env.FEATURE_SOURCE === "mock") {
    return [new MockSourceAdapter()];
  }
  return [
    new HiraHospitalAdapter(http, env.DATA_GO_KR_SERVICE_KEY),
    new FtcFranchiseAdapter(http, env.DATA_GO_KR_SERVICE_KEY),
  ];
}

/** 업종을 담당하는 어댑터를 고른다. 없으면 조용히 넘어가지 않고 던진다. */
export function adapterFor(adapters: readonly SourceAdapter[], industry: Industry): SourceAdapter {
  const found = adapters.find((a) => (a.supportedIndustries as readonly string[]).includes(industry));
  if (!found) {
    throw configError(`'${industry}' 업종을 담당하는 어댑터가 없습니다`, {
      industry,
      available: adapters.map((a) => a.sourceName),
    });
  }
  return found;
}

/** 미검증 어댑터 목록. 스파이크·워커가 이것을 보고 경고를 남긴다. */
export function unverifiedAdapters(adapters: readonly SourceAdapter[]): string[] {
  return adapters.filter((a) => !a.verifiedAgainstLiveApi).map((a) => a.sourceName);
}

/**
 * 검색 어댑터 팩토리 (설계서 3절 `FEATURE_ORS` 3-state).
 *
 *   off    → 어댑터를 만들지 않는다. `search_analyze` 가 건너뛴다. **정상 부팅.**
 *   shadow → 만든다. ORS 를 산출·기록하되 배점은 0.
 *   on     → 만든다. 배점 25 (Phase 4 확증 검증 통과 후에만 설정할 값).
 *
 * `undefined` 를 돌려주는 것이 오류가 아니다 — ORS 없는 축소 파이프라인이 1급 경로다.
 * 반대로 `off` 가 아닌데 전제 조건이 없으면 **조용히 폴백하지 않고** 던진다
 * (자격증명 검사는 env 스키마가, 서면 승인 검사는 어댑터 생성자가 한다).
 */
export function createSearchAdapter(env: Env, http: HttpClient): SearchAdapter | undefined {
  if (env.FEATURE_ORS === "off") return undefined;
  if (env.FEATURE_SOURCE === "mock") return new MockSearchAdapter();
  return new NaverSearchAdapter({
    clientId: env.NAVER_CLIENT_ID ?? "",
    clientSecret: env.NAVER_CLIENT_SECRET ?? "",
    http,
  });
}
