import { AXIS_MAX, type AxisScore } from "@/lib/data/types";

/**
 * 3축 리드 점수. 총점 + 문제/구매/신뢰 미니 바.
 * 바 폭은 축 배점(60:25:15)에 비례 — 점수 구조 자체가 시각화된다.
 * 총점 80 이상만 민트 — 컬러는 중요도 표현에만 쓴다.
 */
export function LeadScore({ score, compact = false }: { score: AxisScore; compact?: boolean }) {
  const axes = [
    { value: score.problem, max: AXIS_MAX.problem },
    { value: score.propensity, max: AXIS_MAX.propensity },
    { value: score.confidence, max: AXIS_MAX.confidence },
  ];
  return (
    <div className="flex items-center gap-2">
      <span
        className={`font-mono text-[13px] font-bold tabular-nums ${
          score.total >= 80 ? "text-mint" : "text-fg"
        }`}
      >
        {score.total}
      </span>
      {!compact && (
        <div className="flex h-1 w-[64px] items-stretch gap-px" aria-hidden>
          {axes.map((axis, i) => (
            <div
              key={i}
              className="relative overflow-hidden rounded-[1px] bg-surface"
              style={{ width: `${axis.max}%` }}
            >
              <div
                className="absolute inset-y-0 left-0 bg-fg-3"
                style={{ width: `${(axis.value / axis.max) * 100}%` }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 드로어용 축 게이지 — 라벨·수치 포함 풀 사이즈. */
export function AxisGauge({
  label,
  value,
  max,
  accent = false,
}: {
  label: string;
  value: number;
  max: number;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="mono-label w-[104px] shrink-0">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-[1px] bg-surface">
        <div
          className={accent ? "h-full bg-mint" : "h-full bg-fg-3"}
          style={{ width: `${(value / max) * 100}%` }}
        />
      </div>
      <span className="w-[52px] shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-3">
        {value}
        <span className="text-fg-2">/{max}</span>
      </span>
    </div>
  );
}
