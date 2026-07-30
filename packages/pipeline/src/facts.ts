import type { Industry, OfficialStatus } from "@leadops/core";
import type { PageKind } from "./contactPages";

/**
 * 점수 계산의 입력 (설계서 부록 A).
 *
 * DB 관측을 **순수 값**으로 옮긴 것이다. 점수 로직이 SQL 을 모르게 하는 이유는 두 가지다.
 *  1. 같은 입력이면 같은 점수가 나와야 한다 (설계서 Phase 5 완료 기준: 점수 재현성).
 *  2. 가중치를 바꿀 때 DB 없이 골드셋으로 회귀를 돌릴 수 있어야 한다.
 */

export interface ChannelFact {
  readonly type: string;
  /** 발행 이력을 가져올 수 있었는가. false 면 활동량을 0 으로 **단정하지 않는다**. */
  readonly analyzable: boolean;
  readonly posts60d: number | null;
  readonly posts120d: number | null;
  /** `YYYY-MM-DD`. */
  readonly lastPostAt: string | null;
  readonly contentMix: Readonly<Record<string, number>>;
}

export interface OrsFact {
  readonly keyword: string;
  readonly keywordKind: "brand" | "nonbrand";
  readonly provider: string;
  readonly denominator: number;
  readonly officialCount: number;
  readonly relatedCount: number;
  /** 분모가 0 이면 null — 측정 불가와 측정값 0 은 다르다. */
  readonly ors: number | null;
}

export interface CompetitorFact {
  readonly competitorId: string;
  readonly isValid: boolean;
  readonly ors: number | null;
  readonly recency60d: number | null;
  readonly diversity: number | null;
  readonly channelActivity: number | null;
}

export interface ScoreFacts {
  readonly companyId: string;
  readonly industry: Industry;
  readonly regionSigungu?: string | null | undefined;
  readonly sizeTier?: "small" | "mid" | "large" | null | undefined;
  readonly doNotContact: boolean;

  readonly officialStatus: OfficialStatus;
  /** 연락처 페이지 후보의 유형. 접점 품질 점수의 입력. */
  readonly contactPageKinds: readonly PageKind[];

  readonly channels: readonly ChannelFact[];
  readonly ors: readonly OrsFact[];
  /** ORS 가 배점에 반영되는가 (`FEATURE_ORS=on` + Phase 4 검증 통과). */
  readonly orsScored: boolean;

  readonly competitors: readonly CompetitorFact[];
  /** 같은 시군구·업종의 업체 수. 지역 경쟁강도의 입력. */
  readonly localCompetitionCount: number;
  /** 기대한 관측 중 실제로 완료된 비율 (0~1). 데이터 신뢰도 축의 입력. */
  readonly analysisCompleteness: number;
  /** 마지막 관측 시각. 소스 신선도의 입력. */
  readonly lastScannedAt?: string | null | undefined;
  /** 기준 시각. 테스트에서 고정하기 위해 주입한다. */
  readonly now?: Date | undefined;
}

/** 분석 가능한 채널만. 가져오지 못한 채널을 "활동 없음" 으로 세면 허위 취약점이 된다. */
export const analyzableChannels = (facts: ScoreFacts): readonly ChannelFact[] =>
  facts.channels.filter((c) => c.analyzable);

/** 유효 경쟁사만 (설계서 A.6 — 2곳 미만이면 격차를 산출하지 않는다). */
export const validCompetitors = (facts: ScoreFacts): readonly CompetitorFact[] =>
  facts.competitors.filter((c) => c.isValid);

export const MIN_VALID_COMPETITORS = 2;

/** 유효 경쟁사가 충분한가. 부족하면 경쟁격차 항목이 `unavailable` 이 된다. */
export const competitorGapAvailable = (facts: ScoreFacts): boolean =>
  validCompetitors(facts).length >= MIN_VALID_COMPETITORS;

export function median(values: readonly number[]): number | null {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 최종 발행일로부터 지난 일수. 발행 이력이 없으면 null. */
export function daysSinceLastPost(facts: ScoreFacts): number | null {
  const now = facts.now ?? new Date();
  const dates = analyzableChannels(facts)
    .map((c) => c.lastPostAt)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .map((d) => Date.parse(`${d}T00:00:00Z`))
    .filter((t) => Number.isFinite(t));
  if (dates.length === 0) return null;
  return Math.floor((now.getTime() - Math.max(...dates)) / DAY_MS);
}

/** 분석 가능한 채널의 발행량 합. 채널이 없거나 전부 분석 불가면 null. */
export function totalPosts(facts: ScoreFacts, window: "posts60d" | "posts120d"): number | null {
  const usable = analyzableChannels(facts).filter((c) => c[window] !== null);
  if (usable.length === 0) return null;
  return usable.reduce((sum, c) => sum + (c[window] ?? 0), 0);
}

/** 공식 채널 유형 수 (블로그·동영상·SNS…). 다양성 신호. */
export const channelTypeCount = (facts: ScoreFacts): number =>
  new Set(facts.channels.map((c) => c.type)).size;
