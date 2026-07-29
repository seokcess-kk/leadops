import { collectStage } from "./collect";
import { contactPagesStage } from "./contactPages";
import { excludeStage } from "./exclude";
import { homepageStage } from "./homepage";
import { normalizeStage } from "./normalize";
import type { StageHandler } from "./types";

export * from "./types";
export * from "./collect";
export * from "./normalize";
export * from "./exclude";
export * from "./homepage";
export * from "./contactPages";

/**
 * 스테이지 레지스트리.
 *
 * Phase 3 범위: 수집 → 정규화 → 기본 제외 → 홈페이지 판별 → 연락처 페이지.
 * 이후 단계(검색·채널·경쟁사·점수)는 Phase 4~5 에서 여기에 추가한다.
 */
export const STAGES: readonly StageHandler[] = [
  collectStage,
  normalizeStage,
  excludeStage,
  homepageStage,
  contactPagesStage,
];

export function stageByName(name: string): StageHandler {
  const found = STAGES.find((s) => s.stage === name);
  if (!found) throw new Error(`알 수 없는 스테이지: ${name}`);
  return found;
}

/**
 * 실행 순서. 의존 관계를 위상 정렬한다.
 *
 * 순환이 있으면 조용히 넘어가지 않고 던진다 — 순환은 설정 실수이지 런타임 상황이 아니다.
 */
export function stageOrder(stages: readonly StageHandler[] = STAGES): string[] {
  const byName = new Map(stages.map((s) => [s.stage, s]));
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (name: string, path: readonly string[]): void => {
    const s = state.get(name);
    if (s === "done") return;
    if (s === "visiting") {
      throw new Error(`스테이지 의존 관계에 순환이 있습니다: ${[...path, name].join(" → ")}`);
    }
    const handler = byName.get(name);
    if (!handler) throw new Error(`알 수 없는 의존 스테이지: ${name}`);
    state.set(name, "visiting");
    for (const dep of handler.dependsOn) visit(dep, [...path, name]);
    state.set(name, "done");
    order.push(name);
  };

  for (const s of stages) visit(s.stage, []);
  return order;
}
