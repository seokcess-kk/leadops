import { configError } from "@leadops/core";

/**
 * 목표치 설정 (`settings.targets`).
 *
 * 설계서 1.4 의 일일 목표는 전부 관리자 조정 가능해야 한다. 값이 없거나 범위를 벗어나면
 * 통과가 아니라 에러다 — 상한이 조용히 사라지면 승인 쿼터가 무의미해진다.
 */
export interface TargetSettings {
  /** 검수 후보 상한 (설계서: 상세 분석·검수 최대 100). */
  readonly reviewMax: number;
  /** 최종 승인 상한 (상한이지 목표가 아니다 — 결론 E). */
  readonly finalMax: number;
  /** 한 업종이 넘을 수 없는 비율 (0~1). */
  readonly industryShareMax: number;
}

export function targetSettingsFrom(settings: Record<string, unknown>): TargetSettings {
  const raw = settings["targets"];
  if (raw === null || typeof raw !== "object") {
    throw configError("설정에 targets 섹션이 없습니다", { keys: Object.keys(settings) });
  }
  const s = raw as Record<string, unknown>;

  const positive = (key: string): number => {
    const v = s[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw configError(`targets.${key} 는 1 이상이어야 합니다`, { key, value: v });
    }
    return v;
  };

  const share = s["industry_share_max"];
  if (typeof share !== "number" || !Number.isFinite(share) || share <= 0 || share > 1) {
    throw configError("targets.industry_share_max 는 0 초과 1 이하여야 합니다", { value: share });
  }

  return {
    reviewMax: positive("review_max"),
    finalMax: positive("final_max"),
    industryShareMax: share,
  };
}

/**
 * 업종별 절대 쿼터.
 *
 * ❗ 비율로 그때그때 판정하면 **순서에 따라 결과가 달라진다** — `(n+1)/(total+1) > share`
 *    형태는 첫 건조차 거절한다(R2-01). 절대 개수로 환산해 순서 독립적으로 만든다.
 */
export const industryQuota = (cap: number, shareMax: number): number => Math.floor(cap * shareMax);
