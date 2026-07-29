import { configError, type Env, type Industry } from "@leadops/core";
import type { HttpClient } from "@leadops/http";
import { FtcFranchiseAdapter } from "./ftc";
import { HiraHospitalAdapter } from "./hira";
import { MockSourceAdapter } from "./mock";
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
