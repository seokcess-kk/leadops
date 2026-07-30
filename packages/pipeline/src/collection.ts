import { configError } from "@leadops/core";
import type { HiraScope } from "@leadops/adapters";

/**
 * 수집 범위 설정 (`settings.collection`).
 *
 * 발주자 결정(2026-07-30)은 `hira_scope = 'name'` 이다 — 기관명에 과목명이 든 의원만
 * 모은다. 피부과는 전체 의원의 45%가 진료과목으로 신고하기 때문에, 신고 기준으로 모으면
 * "피부과 마케팅" 제안이 맞지 않는 일반의원이 대량 섞인다.
 *
 * 값이 없거나 알 수 없는 값이면 **통과가 아니라 에러다.** 조용히 기본값으로 넘어가면
 * 설정 실수가 10배 넓은 수집으로 나타나고, 그것을 알아차릴 방법이 없다.
 */
export interface CollectionSettings {
  readonly hiraScope: HiraScope;
}

const SCOPES: readonly HiraScope[] = ["name", "specialty"];

export function collectionSettingsFrom(settings: Record<string, unknown>): CollectionSettings {
  const raw = settings["collection"];
  if (raw === null || typeof raw !== "object") {
    throw configError("설정에 collection 섹션이 없습니다", { keys: Object.keys(settings) });
  }
  const scope = (raw as Record<string, unknown>)["hira_scope"];
  if (typeof scope !== "string" || !SCOPES.includes(scope as HiraScope)) {
    throw configError(`collection.hira_scope 가 올바르지 않습니다 (가능: ${SCOPES.join(", ")})`, { scope });
  }
  return { hiraScope: scope as HiraScope };
}
