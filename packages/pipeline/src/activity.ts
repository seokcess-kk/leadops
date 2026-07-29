import type { FeedEntry } from "@leadops/adapters";

/**
 * 공식 채널 활성도 산출 (설계서 1.2 채널 분석 · 점수축 "최근 콘텐츠 활동 부족").
 *
 * 이 축은 ORS 없이도 성립하는 축소 파이프라인의 핵심이다(설계서 3절). 그래서 네이버
 * 승인 여부와 무관하게 정확해야 한다.
 *
 * ❗ 판정은 **낮은 쪽에서만 정확하면 된다.** 우리가 찾는 것은 "최근에 아무것도 안 올린 곳"
 *    이므로, 활발한 채널의 발행 수를 정확히 세지 못하는 것은 문제가 아니다. 피드가 창을
 *    다 덮지 못하면 `saturated` 로 표시하고 카운트를 **하한값**으로 다룬다.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 이 비율을 넘게 날짜가 없으면 지표를 신뢰하지 않는다. */
const MAX_UNDATED_RATIO = 0.5;

export interface ActivityMetrics {
  /** 최종 발행일 (KST, `YYYY-MM-DD`). */
  readonly lastPostAt?: string | undefined;
  readonly posts60d: number;
  readonly posts120d: number;
  /** 발행 간격 중앙값(일). 항목이 2개 미만이면 없다. */
  readonly cadenceDays?: number | undefined;
  /**
   * 피드가 120일 창을 다 덮지 못했다.
   * `posts120d` 는 실제값이 아니라 **하한**이라는 뜻이다.
   */
  readonly saturated: boolean;
  /** 콘텐츠 성격 분포. 합은 날짜가 있는 항목 수와 같다. */
  readonly contentMix: Readonly<Record<ContentKind, number>>;
  readonly analyzable: boolean;
  readonly unavailableReason?: string | undefined;
}

export type ContentKind = "event" | "info" | "review" | "notice" | "etc";

/**
 * 제목만으로 콘텐츠 성격을 나눈다.
 *
 * 규칙 기반이다(설계서 비용 원칙: 언어 모델 없이도 핵심 기능이 동작해야 한다).
 * 순서가 우선순위다 — 이벤트성 문구가 정보성보다 강한 신호다.
 */
const CONTENT_RULES: ReadonlyArray<readonly [ContentKind, readonly string[]]> = [
  ["event", ["이벤트", "할인", "프로모션", "특가", "오픈", "경품", "혜택", "쿠폰", "event"]],
  ["notice", ["공지", "휴진", "진료시간", "휴무", "안내드립니다", "임시휴", "notice"]],
  ["review", ["후기", "리뷰", "사례", "전후", "비포", "애프터", "before", "after", "review"]],
  ["info", ["원인", "증상", "치료", "방법", "효과", "종류", "차이", "예방", "관리", "정보", "안내"]],
];

export function classifyContent(title: string): ContentKind {
  const folded = title.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  if (folded.length === 0) return "etc";
  for (const [kind, needles] of CONTENT_RULES) {
    if (needles.some((n) => folded.includes(n))) return kind;
  }
  return "etc";
}

/** KST 기준 `YYYY-MM-DD`. `date` 컬럼에 그대로 넣는다. */
export function toKstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function computeActivity(
  entries: readonly FeedEntry[],
  undatedCount: number,
  now: Date = new Date(),
): ActivityMetrics {
  const emptyMix: Record<ContentKind, number> = { event: 0, info: 0, review: 0, notice: 0, etc: 0 };

  if (entries.length === 0) {
    // 피드는 살아 있는데 글이 없다. 이것도 관측 결과다 — "활동 없음" 이지 오류가 아니다.
    return { posts60d: 0, posts120d: 0, saturated: false, contentMix: emptyMix, analyzable: true };
  }

  if (undatedCount / entries.length > MAX_UNDATED_RATIO) {
    return {
      posts60d: 0,
      posts120d: 0,
      saturated: false,
      contentMix: emptyMix,
      analyzable: false,
      unavailableReason: "feed_dates_unparsable",
    };
  }

  const dated = entries
    .filter((e): e is FeedEntry & { publishedAt: Date } => e.publishedAt !== undefined)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  if (dated.length === 0) {
    return {
      posts60d: 0,
      posts120d: 0,
      saturated: false,
      contentMix: emptyMix,
      analyzable: false,
      unavailableReason: "feed_dates_unparsable",
    };
  }

  const cutoff60 = now.getTime() - 60 * DAY_MS;
  const cutoff120 = now.getTime() - 120 * DAY_MS;

  const posts60d = dated.filter((e) => e.publishedAt.getTime() >= cutoff60).length;
  const posts120d = dated.filter((e) => e.publishedAt.getTime() >= cutoff120).length;

  // 가장 오래된 항목이 120일 경계보다 최근이면 피드가 창을 못 덮은 것이다.
  const oldest = dated[dated.length - 1]!.publishedAt.getTime();
  const saturated = oldest > cutoff120;

  const gaps: number[] = [];
  for (let i = 0; i + 1 < dated.length; i++) {
    const gap = (dated[i]!.publishedAt.getTime() - dated[i + 1]!.publishedAt.getTime()) / DAY_MS;
    if (gap >= 0) gaps.push(gap);
  }
  const cadence = median(gaps);

  const contentMix = { ...emptyMix };
  for (const entry of dated) contentMix[classifyContent(entry.title)]++;

  return {
    lastPostAt: toKstDate(dated[0]!.publishedAt),
    posts60d,
    posts120d,
    ...(cadence === undefined ? {} : { cadenceDays: Math.round(cadence * 100) / 100 }),
    saturated,
    contentMix,
    analyzable: true,
  };
}

/**
 * 이 채널이 "활성" 인가.
 *
 * 60일 안에 발행이 있으면 활성으로 본다. 취약점 판정("최근 콘텐츠 활동 부족")은
 * Phase 5 의 점수 로직이 하고, 여기서는 사실만 남긴다.
 */
export function isActive(metrics: ActivityMetrics): boolean | null {
  if (!metrics.analyzable) return null;
  return metrics.posts60d > 0;
}
