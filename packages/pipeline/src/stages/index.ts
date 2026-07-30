import { channelStage } from "./channel";
import { competitorAnalyzeStage, competitorSelectStage } from "./competitor";
import { collectStage } from "./collect";
import { contactPagesStage } from "./contactPages";
import { excludeStage } from "./exclude";
import { homepageStage } from "./homepage";
import { homepageDiscoverStage } from "./homepageDiscover";
import { normalizeStage } from "./normalize";
import { scoreStage } from "./score";
import { searchStage } from "./search";
import { recommendStage, shortlistStage } from "./shortlist";
import type { StageHandler } from "./types";

export * from "./types";
export * from "./collect";
export * from "./normalize";
export * from "./exclude";
export * from "./homepageDiscover";
export * from "./homepage";
export * from "./contactPages";
export * from "./channel";
export * from "./search";
export * from "./competitor";
export * from "./score";
export * from "./shortlist";

/**
 * 스테이지 레지스트리.
 *
 * Phase 5 범위: 수집 → 정규화 → 기본 제외 → 홈페이지 판별 → 연락처 페이지
 *                → 채널 활성도 · 검색 분석(ORS) · 경쟁사 선정·비교
 *                → 3축 점수 → 추천 · 검수 후보 확정
 * 남은 것은 검수 API·대시보드 연동(Phase 6)과 스케줄러(Phase 7)다.
 */
export const STAGES: readonly StageHandler[] = [
  collectStage,
  normalizeStage,
  excludeStage,
  // ❗ 판정(`homepage_detect`) **앞**이다. 발견은 후보를 만들 뿐이고, 그 후보가 공식인지는
  //    기존 다신호 판정이 그대로 정한다. 순서가 뒤바뀌면 "검색이 찾았으니 공식" 이 된다.
  homepageDiscoverStage,
  homepageStage,
  contactPagesStage,
  channelStage,
  searchStage,
  competitorSelectStage,
  competitorAnalyzeStage,
  scoreStage,
  recommendStage,
  shortlistStage,
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
