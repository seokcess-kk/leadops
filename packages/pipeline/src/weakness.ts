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

/**
 * 취약점 등급 (설계서 부록 A.4).
 *
 * 게이트가 이것에 달려 있다:
 *   strong >= 1  OR  medium >= 2  OR  (clear_gap >= 1 AND medium >= 1)
 *
 * ❗ **약한 기술 SEO 만으로는 리드가 되지 않는다.** `weak` 등급은 기록하되 게이트 계산에
 *    넣지 않는다. title 이 없다는 이유로 영업 전화를 걸 수는 없다.
 *
 * ❗ **관측하지 못한 것을 "없다" 로 세지 않는다.** 피드를 가져오지 못한 채널을 활동 0 으로
 *    취급하면 우리 수집 실패가 상대의 취약점으로 바뀐다. 값이 null 이면 그 취약점은
 *    발화하지 않는다.
 */

export type WeaknessSeverity = "strong" | "medium" | "clear_gap" | "weak";

export interface Weakness {
  readonly kind: string;
  readonly severity: WeaknessSeverity;
  /** 검수 화면에 그대로 보여줄 한 줄. */
  readonly label: string;
  /** 판정 근거 수치. */
  readonly metric?: string | undefined;
}

/** 경쟁사 중앙값 대비 이만큼 이하면 `clear_gap` 이다 (설계서: 60% 이상 열위). */
export const CLEAR_GAP_RATIO = 0.4;

/** 기술 SEO 신호. 단독으로는 리드 불가이므로 게이트에서 제외된다. */
export interface TechSignals {
  readonly hasTitle?: boolean | undefined;
  readonly https?: boolean | undefined;
  readonly hasNoindex?: boolean | undefined;
}

export function gradeWeaknesses(facts: ScoreFacts, tech: TechSignals = {}): Weakness[] {
  const out: Weakness[] = [];
  const usable = analyzableChannels(facts);
  const posts60 = totalPosts(facts, "posts60d");
  const posts120 = totalPosts(facts, "posts120d");

  // ── strong ──

  // 공식 채널이 아예 없다. 관측 실패가 아니라 **부재**이므로 확정할 수 있다.
  if (facts.channels.length === 0) {
    out.push({
      kind: "no_official_channel",
      severity: "strong",
      label: "공식 채널이 전혀 없음",
      metric: "블로그·유튜브·SNS 0개",
    });
  } else if (posts120 === 0) {
    out.push({
      kind: "dormant_120d",
      severity: "strong",
      label: "최근 120일 공식 콘텐츠 0건",
      metric: `채널 ${usable.length}개 모두 무발행`,
    });
  }

  // 대표 키워드 다수에서 관련 문서가 회수되지 않는다 (ORS 필요).
  const nonbrand = facts.ors.filter((o) => o.keywordKind === "nonbrand" && o.denominator > 0);
  if (nonbrand.length > 0) {
    const byKeyword = new Map<string, number>();
    for (const row of nonbrand) {
      byKeyword.set(row.keyword, (byKeyword.get(row.keyword) ?? 0) + row.relatedCount);
    }
    const empty = [...byKeyword.values()].filter((n) => n === 0).length;
    if (byKeyword.size >= 2 && empty >= 2) {
      out.push({
        kind: "no_nonbrand_retrieval",
        severity: "strong",
        label: "비브랜드 대표 키워드에서 관련 문서 회수 0건",
        metric: `키워드 ${byKeyword.size}개 중 ${empty}개`,
      });
    }
  }

  // ── medium ──

  if (posts120 !== 0 && posts60 === 0) {
    out.push({
      kind: "dormant_60d",
      severity: "medium",
      label: "최근 60일 공식 콘텐츠 0건",
      metric: posts120 === null ? undefined : `120일 기준 ${posts120}건`,
    });
  }

  const types = channelTypeCount(facts);
  if (facts.channels.length > 0 && types <= 2) {
    out.push({
      kind: "low_channel_diversity",
      severity: "medium",
      label: "공식 채널 유형이 단조로움",
      metric: `유형 ${types}종`,
    });
  }

  // 제3자 콘텐츠 부재 — 남이 우리 얘기를 하지 않는다 (ORS 필요).
  const scored = facts.ors.filter((o) => o.denominator > 0);
  if (scored.length > 0) {
    const thirdParty = scored.reduce((sum, o) => sum + Math.max(o.relatedCount - o.officialCount, 0), 0);
    if (thirdParty === 0) {
      out.push({
        kind: "no_thirdparty_content",
        severity: "medium",
        label: "제3자 콘텐츠 언급 0건",
        metric: `채널행 ${scored.length}건 기준`,
      });
    }
  }

  const stale = daysSinceLastPost(facts);
  if (stale !== null && stale >= 180) {
    out.push({
      kind: "stale_last_post",
      severity: "medium",
      label: "최종 발행일이 오래됨",
      metric: `${stale}일 경과`,
    });
  }

  // ── clear_gap: 경쟁사 대비 명확한 열위 ──
  //
  // ORS 가 배점에 반영될 때는 ORS 로 재고, 그렇지 않으면(기본값) **채널 활성도**로 잰다.
  // 설계서 A.4 는 ORS 기준만 적었지만, 모드 B 에서는 ORS 가 없으므로 그대로 두면
  // clear_gap 이 영구히 발화하지 않고 예산 신호 규칙(A.3)이 다시 dead code 가 된다.
  if (competitorGapAvailable(facts)) {
    const peers = validCompetitors(facts);
    if (facts.orsScored) {
      const mine = median(facts.ors.filter((o) => o.ors !== null).map((o) => o.ors!));
      const theirs = median(peers.map((c) => c.ors).filter((v): v is number => v !== null));
      if (mine !== null && theirs !== null && theirs > 0 && mine <= theirs * CLEAR_GAP_RATIO) {
        out.push({
          kind: "ors_gap",
          severity: "clear_gap",
          label: "경쟁사 대비 콘텐츠 회수 점유 열위",
          metric: `당사 ${(mine * 100).toFixed(1)}% vs 경쟁 중앙값 ${(theirs * 100).toFixed(1)}%`,
        });
      }
    } else {
      const mine = posts60;
      const theirs = median(peers.map((c) => c.channelActivity).filter((v): v is number => v !== null));
      if (mine !== null && theirs !== null && theirs > 0 && mine <= theirs * CLEAR_GAP_RATIO) {
        out.push({
          kind: "channel_activity_gap",
          severity: "clear_gap",
          label: "경쟁사 대비 채널 활동량 열위",
          metric: `당사 60일 ${mine}건 vs 경쟁 중앙값 ${theirs.toFixed(1)}건`,
        });
      }
    }
  }

  // ── weak: 기술 SEO. 게이트에 넣지 않는다 ──
  if (tech.hasTitle === false) {
    out.push({ kind: "no_title", severity: "weak", label: "페이지 제목 없음" });
  }
  if (tech.https === false) {
    out.push({ kind: "no_https", severity: "weak", label: "https 미적용" });
  }
  if (tech.hasNoindex === true) {
    out.push({ kind: "noindex", severity: "weak", label: "검색 색인 차단 설정" });
  }

  return out;
}

export interface WeaknessTally {
  readonly strong: number;
  readonly medium: number;
  readonly clearGap: number;
  readonly weak: number;
}

export function tally(weaknesses: readonly Weakness[]): WeaknessTally {
  const count = (s: WeaknessSeverity): number => weaknesses.filter((w) => w.severity === s).length;
  return { strong: count("strong"), medium: count("medium"), clearGap: count("clear_gap"), weak: count("weak") };
}

/**
 * 취약점 게이트 (설계서 A.5 공통 조건).
 *
 * `weak` 은 세지 않는다 — 기술 SEO 만으로는 영업 근거가 되지 않는다.
 */
export function weaknessGatePassed(t: WeaknessTally): boolean {
  return t.strong >= 1 || t.medium >= 2 || (t.clearGap >= 1 && t.medium >= 1);
}
