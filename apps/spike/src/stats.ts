/**
 * 표본 통계 (설계서 9.1).
 *
 * ❗ **가설검정을 하지 않는다.** 점추정 + 95% 신뢰구간만 보고한다 (설계서 9.1).
 *    n=120 에서 p-value 를 내면 통과·실패를 단정하는 것처럼 읽히고, 그것이 F-20 이
 *    Phase 0 을 "탐색적" 으로 분리한 이유다.
 *
 * ❗ 비율의 CI 는 **Wilson** 이다. 정규근사(Wald)는 p 가 0·1 에 가까울 때 구간이
 *    [0,1] 을 벗어나고, 골드셋에서 "0건 관측" 은 실제로 흔하다 (M12 가 그 경우다).
 */

/** 표준정규 97.5 분위. 95% 양측 구간에 쓴다. */
const Z_975 = 1.959963984540054;

export interface Proportion {
  numerator: number;
  denominator: number;
  /** 분모가 0 이면 null — 0% 가 아니다. 측정하지 못한 것과 0 을 구분한다. */
  point: number | null;
  low: number | null;
  high: number | null;
}

/**
 * Wilson score interval.
 *
 * 분모가 0 이면 `null` 을 돌려준다. 0/0 을 0% 로 보고하면 "그런 사례가 없었다" 가
 * "그 비율이 0이다" 로 바뀐다 — 설계서 A.6 과 같은 원칙이다.
 */
export function wilson(numerator: number, denominator: number, z = Z_975): Proportion {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator < 0) {
    throw new Error(`잘못된 비율 입력: ${numerator}/${denominator}`);
  }
  if (numerator > denominator) {
    throw new Error(`분자가 분모보다 큽니다: ${numerator}/${denominator}`);
  }
  if (denominator === 0) {
    return { numerator, denominator, point: null, low: null, high: null };
  }

  const n = denominator;
  const p = numerator / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  return {
    numerator,
    denominator,
    point: p,
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
  };
}

export interface Correlation {
  n: number;
  /** 표본 상관. n<3 이면 null. */
  rho: number | null;
  low: number | null;
  high: number | null;
  /** 동순위(tie) 가 많으면 해석에 주의가 필요하다. */
  tiedPairs: number;
}

/** 동순위를 평균 순위로 처리한다 (Spearman 의 표준 처리). */
function rank(values: readonly number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const averaged = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = averaged;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman ρ 와 Fisher z 기반 95% CI (M7).
 *
 * ❗ M7 은 **stop 게이트**다 (설계서 9.1 · 1550행): CI 상한 < 0.4 면 중단.
 *    그래서 점추정만 내지 않고 상한을 반드시 함께 돌려준다 — 상한 없이는 게이트를
 *    적용할 수 없다.
 * ❗ 동순위가 많으면 Fisher z 근사가 낙관적이다. `tiedPairs` 를 함께 보고해 해석자가
 *    알 수 있게 한다.
 */
export function spearman(xs: readonly number[], ys: readonly number[]): Correlation {
  if (xs.length !== ys.length) {
    throw new Error(`길이가 다릅니다: ${xs.length} vs ${ys.length}`);
  }
  const n = xs.length;
  const tiedPairs =
    new Set(xs).size < n || new Set(ys).size < n
      ? n - Math.min(new Set(xs).size, new Set(ys).size)
      : 0;

  if (n < 3) return { n, rho: null, low: null, high: null, tiedPairs };

  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  // 한쪽이 전부 동순위면 상관이 정의되지 않는다. 0 으로 채우지 않는다.
  if (dx === 0 || dy === 0) return { n, rho: null, low: null, high: null, tiedPairs };

  const rho = num / Math.sqrt(dx * dy);

  // Fisher z. |rho| = 1 이면 atanh 이 발산하므로 경계를 살짝 당긴다.
  const clamped = Math.max(-0.999999, Math.min(0.999999, rho));
  const zr = Math.atanh(clamped);
  const se = 1 / Math.sqrt(n - 3);
  return {
    n,
    rho,
    low: Math.tanh(zr - Z_975 * se),
    high: Math.tanh(zr + Z_975 * se),
    tiedPairs,
  };
}

/** 백분율 표기. `null` 은 `—` 다 — 0% 로 채우지 않는다. */
export function pct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

/** 구간 표기. */
export function ci(p: Proportion): string {
  return p.low === null || p.high === null ? "—" : `[${pct(p.low)}, ${pct(p.high)}]`;
}
