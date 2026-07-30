import type { AxisResult, ScoreItem } from "./scoring";
import type { Weakness } from "./weakness";

/**
 * 추천 서비스 매핑 (설계서 부록 A.7).
 *
 * ❗ **선정은 규칙이 한다. 언어 모델은 문장 정리에만 쓴다.**
 *    이 함수는 LLM 없이 완결된다 (`FEATURE_LLM=off` 전체 통과가 Phase 5 완료 기준이다).
 *    LLM 이 서비스를 고르게 하면 같은 관측에서 다른 제안이 나오고, 왜 그 제안인지
 *    설명할 수 없게 된다.
 *
 * 주력 1개는 **가장 큰 문제 항목**에서, 보조 최대 2개는 차순위에서 고른다.
 */

export const SERVICES = [
  "검색 점유·SEO 콘텐츠",
  "매체 광고",
  "콘텐츠 마케팅",
  "홈페이지 개선",
] as const;
export type Service = (typeof SERVICES)[number];

/** 동점일 때의 우선순위. 설계서 A.7 의 나열 순서다. */
const PRIORITY: readonly Service[] = SERVICES;

/**
 * 문제 항목 → 서비스.
 *
 * 키는 `scoring.ts` 의 `ScoreItem.key` 다. 매핑이 없는 항목은 추천 근거가 되지 않는다
 * (예: 지역 경쟁강도는 문제가 아니라 시장 조건이다).
 */
const ITEM_SERVICE: Readonly<Record<string, Service>> = {
  // 검색에서 우리 것이 회수되지 않는다 → 검색 점유·SEO
  ors_no_official: "검색 점유·SEO 콘텐츠",
  ors_no_nonbrand: "검색 점유·SEO 콘텐츠",
  gap_ors: "검색 점유·SEO 콘텐츠",
  // 경쟁사가 앞서 있다 → 매체로 따라잡는다
  gap_recency: "매체 광고",
  gap_activity: "매체 광고",
  gap_diversity: "매체 광고",
  // 발행 자체가 없다 → 콘텐츠를 만들어야 한다
  no_recent_content: "콘텐츠 마케팅",
  content_60d: "콘텐츠 마케팅",
  content_120d: "콘텐츠 마케팅",
  content_stale: "콘텐츠 마케팅",
  ors_no_thirdparty: "콘텐츠 마케팅",
  ors_low_diversity: "콘텐츠 마케팅",
  // 접점이 부실하다 → 홈페이지
  contact_exists: "홈페이지 개선",
  contact_kind: "홈페이지 개선",
};

export interface Recommendation {
  readonly primaryService: Service;
  readonly secondaryServices: readonly Service[];
  readonly rationale: string;
  /** 규칙으로 만들었는지, 언어 모델이 문장을 정리했는지. */
  readonly rationaleSource: "rule";
}

interface Weighted {
  readonly service: Service;
  readonly points: number;
  readonly items: string[];
}

/**
 * 추천에 필요한 최소 입력.
 *
 * 전체 `ScoreResult` 를 요구하지 않는 이유: `recommend` 스테이지는 DB 의
 * `scores.breakdown`·`scores.weaknesses` 에서 복원해 호출한다. 필요한 만큼만 받으면
 * 복원이 단순해지고, 점수 구조가 바뀌어도 추천이 따라 깨지지 않는다.
 */
export interface RecommendInput {
  readonly problem: Pick<AxisResult, "items">;
  readonly propensity: Pick<AxisResult, "items">;
  readonly weaknesses: readonly Weakness[];
}

/**
 * 문제 항목의 득점을 서비스별로 합산한다.
 *
 * 여기서 "득점" 은 **결핍의 크기**다. 문제 크기 축은 부족할수록 점수가 높으므로,
 * 점수가 큰 항목이 곧 가장 아픈 곳이다.
 */
function weigh(result: RecommendInput): Weighted[] {
  const byService = new Map<Service, Weighted>();

  const consider = (item: ScoreItem): void => {
    // 접점 품질은 **감점 방향이 반대**다 — 점수가 낮을수록 문제다.
    const inverted = item.key === "contact_exists" || item.key === "contact_kind";
    const magnitude = item.unavailable ? 0 : inverted ? item.max - item.points : item.points;
    if (magnitude <= 0) return;

    const service = ITEM_SERVICE[item.key];
    if (!service) return;

    const existing = byService.get(service);
    if (existing) {
      byService.set(service, {
        service,
        points: existing.points + magnitude,
        items: [...existing.items, item.label],
      });
    } else {
      byService.set(service, { service, points: magnitude, items: [item.label] });
    }
  };

  for (const item of result.problem.items) consider(item);
  for (const item of result.propensity.items) consider(item);

  return [...byService.values()].sort(
    (a, b) => b.points - a.points || PRIORITY.indexOf(a.service) - PRIORITY.indexOf(b.service),
  );
}

export function recommend(result: RecommendInput): Recommendation {
  const ranked = weigh(result);

  // 문제 항목이 하나도 없으면(이론상 게이트를 통과할 수 없다) 우선순위 1번으로 폴백한다.
  const primary = ranked[0]?.service ?? PRIORITY[0]!;
  const secondary = ranked.slice(1, 3).map((w) => w.service);

  const top = ranked[0];
  const reasons = top ? top.items.slice(0, 3).join(" · ") : "관측된 문제 항목 없음";
  const strong = result.weaknesses.filter((w) => w.severity === "strong").map((w) => w.label);

  const rationale =
    `${primary} 를 주력으로 제안합니다. 근거: ${reasons}.` +
    (strong.length > 0 ? ` 강한 취약점: ${strong.join(" · ")}.` : "") +
    (secondary.length > 0 ? ` 보조 제안: ${secondary.join(" · ")}.` : "");

  return { primaryService: primary, secondaryServices: secondary, rationale, rationaleSource: "rule" };
}
