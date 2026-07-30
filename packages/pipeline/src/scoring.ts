import { configError, type Industry } from "@leadops/core";
import {
  analyzableChannels,
  channelTypeCount,
  competitorGapAvailable,
  daysSinceLastPost,
  median,
  totalPosts,
  validCompetitors,
  type ScoreFacts,
} from "./facts";
import { gradeWeaknesses, tally, weaknessGatePassed, type TechSignals, type Weakness, type WeaknessTally } from "./weakness";

/**
 * 3축 점수 (설계서 부록 A).
 *
 * ❗ v1 은 **하나의 잠재변수를 세 번 측정**했다 — 검색공백 35 + 콘텐츠부족 15 + 경쟁격차 20 =
 *    70점이 전부 "온라인 활동량이 적다" 였다. 그래서 총점 60이 독립적인 품질 경계라는 근거가
 *    없고 점수가 임계값 근처에 인위적으로 군집했다(F-21). v2 는 축을 분리하고 **축별 하한**을
 *    함께 둔다.
 *
 * ❗ **측정하지 못한 항목을 0점으로 세지 않는다.** `unavailable` 로 표시하고 만점에서도 뺀다.
 *    경쟁사가 부족한데 격차 20점을 0으로 주면 우리 수집 실패가 상대의 취약점이 된다(A.6).
 *    **재정규화도 하지 않는다** — 대신 게이트에서 탈락시킨다.
 */

export const RULE_VERSION_FALLBACK = "v3-2026-07-30";

export type ScoringMode = "ors_disabled" | "ors_enabled";

export interface ScoringSettings {
  readonly mode: ScoringMode;
  readonly axisProblemMin: number;
  readonly axisPropensityMin: number;
  readonly axisConfidenceMin: number;
  readonly totalMinNormalized: number;
  readonly ruleVersion: string;
}

export function scoringSettingsFrom(settings: Record<string, unknown>): ScoringSettings {
  const raw = settings["scoring"];
  if (raw === null || typeof raw !== "object") {
    throw configError("설정에 scoring 섹션이 없습니다", { keys: Object.keys(settings) });
  }
  const s = raw as Record<string, unknown>;
  const num = (key: string): number => {
    const v = s[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw configError(`scoring.${key} 가 올바르지 않습니다`, { key, value: v });
    }
    return v;
  };
  const mode = s["mode"];
  if (mode !== "ors_disabled" && mode !== "ors_enabled") {
    throw configError("scoring.mode 는 ors_disabled 또는 ors_enabled 여야 합니다", { mode });
  }
  const ruleVersion = s["rule_version"];
  return {
    mode,
    axisProblemMin: num("axis_problem_min"),
    axisPropensityMin: num("axis_propensity_min"),
    axisConfidenceMin: num("axis_confidence_min"),
    totalMinNormalized: num("total_min_normalized"),
    ruleVersion: typeof ruleVersion === "string" && ruleVersion ? ruleVersion : RULE_VERSION_FALLBACK,
  };
}

export interface ScoreItem {
  readonly key: string;
  readonly label: string;
  readonly points: number;
  readonly max: number;
  /** 측정 불가. 0점과 구분한다. 만점에서도 빠진다. */
  readonly unavailable?: boolean;
  readonly note?: string | undefined;
}

export interface AxisResult {
  readonly points: number;
  /** 측정 가능한 항목만 합한 만점. `unavailable` 항목은 빠진다. */
  readonly max: number;
  readonly items: readonly ScoreItem[];
}

export interface ScoreResult {
  readonly problem: AxisResult;
  readonly propensity: AxisResult;
  readonly confidence: AxisResult;
  readonly total: number;
  readonly totalMax: number;
  /** 100점 환산. 모드 B 의 만점이 67 이므로 요구사항의 "60점" 은 이 값으로 판정한다. */
  readonly normalized: number;
  readonly weaknesses: readonly Weakness[];
  readonly tally: WeaknessTally;
  readonly competitorGapAvailable: boolean;
  readonly orsScored: boolean;
  readonly marketingActivity: "high" | "low";
  readonly gatePassed: boolean;
  /** 탈락 사유. 통과하면 없다. 조용히 떨어지지 않게 반드시 남긴다. */
  readonly gateReason?: string | undefined;
  readonly ruleVersion: string;
}

const axis = (items: readonly ScoreItem[]): AxisResult => ({
  points: round2(items.reduce((sum, i) => sum + (i.unavailable ? 0 : i.points), 0)),
  max: items.reduce((sum, i) => sum + (i.unavailable ? 0 : i.max), 0),
  items,
});

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 업종별 단가 가점 (0~4).
 *
 * ⚠️ **근거 없는 값이다.** 시술 단가가 높은 업종일수록 마케팅 예산이 크다는 통념에
 *    기댄 것이고, 실제 계약 데이터로 검증한 바 없다. 골드셋·수주 결과가 쌓이면
 *    먼저 조정할 후보다.
 */
const INDUSTRY_TICKET: Record<Industry, number> = { plastic: 4, derm: 4, dental: 3, franchise: 2 };

// ── 축 1 · 문제 크기 ─────────────────────────────────────────────────────────

function problemAxis(facts: ScoreFacts, mode: ScoringMode): AxisResult {
  const items: ScoreItem[] = [];
  const orsOn = mode === "ors_enabled" && facts.orsScored;
  const scoredOrs = facts.ors.filter((o) => o.denominator > 0);
  const gapAvailable = competitorGapAvailable(facts);
  const peers = validCompetitors(facts);

  // ── ORS 공백 25점 (모드 B 에서는 항목 자체가 없다) ──
  if (orsOn) {
    const officialTotal = scoredOrs.reduce((s, o) => s + o.officialCount, 0);
    const thirdParty = scoredOrs.reduce((s, o) => s + Math.max(o.relatedCount - o.officialCount, 0), 0);
    const channelsWithContent = new Set(scoredOrs.filter((o) => o.relatedCount > 0).map((o) => o.provider)).size;
    const nonbrand = scoredOrs.filter((o) => o.keywordKind === "nonbrand");
    const nonbrandRetrieved = nonbrand.reduce((s, o) => s + o.relatedCount, 0);

    if (scoredOrs.length === 0) {
      items.push({
        key: "ors_gap",
        label: "ORS 공백",
        points: 0,
        max: 25,
        unavailable: true,
        note: "측정 가능한 채널이 없습니다",
      });
    } else {
      items.push(
        { key: "ors_no_official", label: "공식 자산 회수 부재", points: officialTotal === 0 ? 10 : 0, max: 10 },
        { key: "ors_no_thirdparty", label: "제3자 콘텐츠 부재", points: thirdParty === 0 ? 8 : 0, max: 8 },
        {
          key: "ors_low_diversity",
          label: "회수 채널 다양성 부족",
          points: channelsWithContent <= 1 ? 4 : channelsWithContent === 2 ? 2 : 0,
          max: 4,
          note: `${channelsWithContent}/4 채널`,
        },
        {
          key: "ors_no_nonbrand",
          label: "비브랜드 회수 부재",
          points: nonbrand.length > 0 && nonbrandRetrieved === 0 ? 3 : 0,
          max: 3,
        },
      );
    }
  }

  // ── 경쟁사 대비 격차 (ORS 격차 8 은 모드 B 에서 제외 → 12점) ──
  if (!gapAvailable) {
    // ❗ 0점이 아니라 unavailable 이다. 재정규화하지 않고 게이트에서 탈락시킨다 (A.6).
    items.push({
      key: "competitor_gap",
      label: "경쟁사 대비 격차",
      points: 0,
      max: orsOn ? 20 : 12,
      unavailable: true,
      note: `유효 경쟁사 ${peers.length}곳 (2곳 필요)`,
    });
  } else {
    if (orsOn) {
      const mine = median(facts.ors.filter((o) => o.ors !== null).map((o) => o.ors!));
      const theirs = median(peers.map((c) => c.ors).filter((v): v is number => v !== null));
      items.push({
        key: "gap_ors",
        label: "ORS 격차",
        points: behind(mine, theirs) ? 8 : 0,
        max: 8,
        note: fmtPair(mine, theirs),
      });
    }
    const myPosts = totalPosts(facts, "posts60d");
    const theirRecency = median(peers.map((c) => c.recency60d).filter((v): v is number => v !== null));
    items.push({
      key: "gap_recency",
      label: "최근성 격차",
      points: behind(myPosts, theirRecency) ? 5 : 0,
      max: 5,
      note: fmtPair(myPosts, theirRecency),
    });

    const myDiversity = channelTypeCount(facts);
    const theirDiversity = median(peers.map((c) => c.diversity).filter((v): v is number => v !== null));
    items.push({
      key: "gap_diversity",
      label: "채널 다양성 격차",
      points: behind(myDiversity, theirDiversity) ? 4 : 0,
      max: 4,
      note: fmtPair(myDiversity, theirDiversity),
    });

    const myActivity = totalPosts(facts, "posts120d");
    const theirActivity = median(peers.map((c) => c.channelActivity).filter((v): v is number => v !== null));
    items.push({
      key: "gap_activity",
      label: "채널 활성도 격차",
      points: behind(myActivity, theirActivity) ? 3 : 0,
      max: 3,
      note: fmtPair(myActivity, theirActivity),
    });
  }

  // ── 최근 콘텐츠 활동 부족 15점 (ORS 와 무관 — 축소 파이프라인의 핵심) ──
  const posts60 = totalPosts(facts, "posts60d");
  const posts120 = totalPosts(facts, "posts120d");
  const stale = daysSinceLastPost(facts);

  if (facts.channels.length === 0) {
    // 채널이 없는 것은 관측 실패가 아니라 부재다. 만점을 준다.
    items.push({
      key: "no_recent_content",
      label: "최근 콘텐츠 활동 부족",
      points: 15,
      max: 15,
      note: "공식 채널 없음",
    });
  } else if (posts60 === null && posts120 === null) {
    items.push({
      key: "no_recent_content",
      label: "최근 콘텐츠 활동 부족",
      points: 0,
      max: 15,
      unavailable: true,
      note: `채널 ${facts.channels.length}개 모두 분석 불가`,
    });
  } else {
    items.push(
      { key: "content_60d", label: "최근 60일 무발행", points: posts60 === 0 ? 8 : 0, max: 8, note: `${posts60 ?? "?"}건` },
      {
        key: "content_120d",
        label: "61~120일 무발행",
        points: posts120 === 0 ? 4 : 0,
        max: 4,
        note: `${posts120 ?? "?"}건`,
      },
      {
        key: "content_stale",
        label: "최종 발행일 경과",
        points: stale === null ? 3 : stale >= 180 ? 3 : stale >= 90 ? 2 : 0,
        max: 3,
        note: stale === null ? "발행 이력 없음" : `${stale}일`,
      },
    );
  }

  return axis(items);
}

/** 우리 값이 경쟁 중앙값의 40% 이하인가. 둘 중 하나라도 없으면 격차로 보지 않는다. */
function behind(mine: number | null, theirs: number | null): boolean {
  if (mine === null || theirs === null || theirs <= 0) return false;
  return mine <= theirs * 0.4;
}

const fmtPair = (mine: number | null, theirs: number | null): string =>
  `당사 ${mine ?? "?"} vs 경쟁 중앙값 ${theirs === null ? "?" : round2(theirs)}`;

// ── 축 2 · 구매 가능성 ───────────────────────────────────────────────────────

/**
 * 마케팅 활동 수준.
 *
 * ⚠️ 광고 랜딩 페이지 탐지는 구현되지 않았다. 지금은 **채널 수**와 **이벤트성 콘텐츠 비율**
 *    두 신호만 본다. 설계서 A.3 이 적은 "광고 랜딩 흔적" 은 빠져 있다.
 */
export function marketingActivityOf(facts: ScoreFacts): "high" | "low" {
  if (facts.channels.length >= 2) return "high";
  const usable = analyzableChannels(facts);
  const total = usable.reduce((s, c) => s + Object.values(c.contentMix).reduce((a, b) => a + b, 0), 0);
  const events = usable.reduce((s, c) => s + (c.contentMix["event"] ?? 0), 0);
  return total > 0 && events / total >= 0.3 ? "high" : "low";
}

function propensityAxis(facts: ScoreFacts, weaknesses: WeaknessTally): AxisResult {
  const items: ScoreItem[] = [];

  // ── 사업성·제안 적합도 10 ──
  items.push({
    key: "industry_ticket",
    label: "업종 단가",
    points: INDUSTRY_TICKET[facts.industry],
    max: 4,
    note: facts.industry,
  });
  items.push({
    key: "local_competition",
    label: "지역 경쟁강도",
    points: facts.localCompetitionCount >= 20 ? 3 : facts.localCompetitionCount >= 8 ? 2 : 1,
    max: 3,
    note: `동일 시군구·업종 ${facts.localCompetitionCount}곳`,
  });
  items.push({
    key: "size_fit",
    label: "규모 적합",
    points: facts.sizeTier === "small" ? 3 : facts.sizeTier === "mid" ? 2 : facts.sizeTier === "large" ? 0 : 1,
    max: 3,
    note: facts.sizeTier ?? "미상",
  });

  // ── 예산 신호 10 (설계서 A.3 상호작용 규칙) ──
  //
  // ❗ 무조건 가점하면 **이미 마케팅이 잘 되는 업체를 좋은 취약 리드로 만든다.**
  //    v2 는 조건을 `axis_problem < 32` 로 걸었는데 게이트 통과 후보는 정의상 그 위여서
  //    dead code 였다(R2-11). v3 는 `clear_gap` 으로 바꿨다 — 게이트의 필수 조건이 아니라
  //    실제로 변별력이 있다.
  const activity = marketingActivityOf(facts);
  const hasClearGap = weaknesses.clearGap >= 1;
  const budget =
    activity === "high"
      ? hasClearGap
        ? { points: 10, note: "예산 신호 있음 + 경쟁사 대비 명확한 격차 → 최우선" }
        : { points: 2, note: "이미 경쟁사 수준 → 교체 설득 어려움" }
      : weaknesses.strong >= 1
        ? { points: 6, note: "예산 불확실하나 문제가 큼" }
        : { points: 3, note: "예산 신호 약함" };
  items.push({ key: "budget_signal", label: "예산 신호", max: 10, ...budget });

  // ── 접점 품질 5 ──
  const kinds = new Set(facts.contactPageKinds);
  const hasPartnership = kinds.has("partnership") || kinds.has("contact");
  items.push({
    key: "contact_exists",
    label: "연락처 페이지 존재",
    points: facts.contactPageKinds.length > 0 ? 3 : 0,
    max: 3,
    note: `${facts.contactPageKinds.length}건`,
  });
  items.push({
    key: "contact_kind",
    label: "연락처 페이지 유형",
    points: hasPartnership ? 2 : kinds.size > 0 ? 1 : 0,
    max: 2,
    note: [...kinds].join(", ") || "없음",
  });

  return axis(items);
}

// ── 축 3 · 데이터 신뢰도 ─────────────────────────────────────────────────────

function confidenceAxis(facts: ScoreFacts): AxisResult {
  const items: ScoreItem[] = [];

  items.push({
    key: "official_status",
    label: "공식 판정 등급",
    points: facts.officialStatus === "confirmed" ? 5 : facts.officialStatus === "likely" ? 3 : 0,
    max: 5,
    note: facts.officialStatus,
  });

  const completeness = Math.max(0, Math.min(1, facts.analysisCompleteness));
  items.push({
    key: "analysis_completeness",
    label: "분석 완료 항목 비율",
    points: round2(completeness * 5),
    max: 5,
    note: `${Math.round(completeness * 100)}%`,
  });

  const peers = validCompetitors(facts).length;
  const stale = freshnessDays(facts);
  const peerPoints = peers >= 3 ? 3 : peers === 2 ? 2 : 0;
  const freshPoints = stale === null ? 0 : stale <= 7 ? 2 : stale <= 30 ? 1 : 0;
  items.push({
    key: "competitor_freshness",
    label: "유효 경쟁사 수 + 소스 신선도",
    points: peerPoints + freshPoints,
    max: 5,
    note: `경쟁사 ${peers}곳 / 관측 ${stale === null ? "?" : `${stale}일 전`}`,
  });

  return axis(items);
}

function freshnessDays(facts: ScoreFacts): number | null {
  if (!facts.lastScannedAt) return null;
  const t = Date.parse(facts.lastScannedAt);
  if (!Number.isFinite(t)) return null;
  return Math.floor(((facts.now ?? new Date()).getTime() - t) / (24 * 60 * 60 * 1000));
}

// ── 종합 ─────────────────────────────────────────────────────────────────────

export function score(facts: ScoreFacts, settings: ScoringSettings, tech: TechSignals = {}): ScoreResult {
  const weaknesses = gradeWeaknesses(facts, tech);
  const counts = tally(weaknesses);

  const problem = problemAxis(facts, settings.mode);
  const propensity = propensityAxis(facts, counts);
  const confidence = confidenceAxis(facts);

  const total = round2(problem.points + propensity.points + confidence.points);
  const totalMax = problem.max + propensity.max + confidence.max;
  const normalized = totalMax > 0 ? round2((total / totalMax) * 100) : 0;
  const gapAvailable = competitorGapAvailable(facts);

  // ── 게이트 (설계서 A.5) ──
  // 첫 번째 실패 사유만 남기지 않고 전부 모은다. "왜 떨어졌나" 를 한 번에 알아야 한다.
  const failures: string[] = [];
  if (facts.doNotContact) failures.push("do_not_contact");
  if (facts.officialStatus !== "confirmed" && facts.officialStatus !== "likely") {
    failures.push(`official_status=${facts.officialStatus}`);
  }
  if (!gapAvailable) failures.push(`competitor_gap_unavailable(${validCompetitors(facts).length}/2)`);
  if (problem.points < settings.axisProblemMin) {
    failures.push(`axis_problem ${problem.points}<${settings.axisProblemMin}`);
  }
  if (propensity.points < settings.axisPropensityMin) {
    failures.push(`axis_propensity ${propensity.points}<${settings.axisPropensityMin}`);
  }
  if (confidence.points < settings.axisConfidenceMin) {
    failures.push(`axis_confidence ${confidence.points}<${settings.axisConfidenceMin}`);
  }
  if (normalized < settings.totalMinNormalized) {
    failures.push(`total ${normalized}<${settings.totalMinNormalized} (100점 환산)`);
  }
  if (!weaknessGatePassed(counts)) {
    failures.push(`weakness(strong=${counts.strong} medium=${counts.medium} clear_gap=${counts.clearGap})`);
  }

  return {
    problem,
    propensity,
    confidence,
    total,
    totalMax,
    normalized,
    weaknesses,
    tally: counts,
    competitorGapAvailable: gapAvailable,
    orsScored: settings.mode === "ors_enabled" && facts.orsScored,
    marketingActivity: marketingActivityOf(facts),
    gatePassed: failures.length === 0,
    ...(failures.length === 0 ? {} : { gateReason: failures.join(" · ") }),
    ruleVersion: settings.ruleVersion,
  };
}
