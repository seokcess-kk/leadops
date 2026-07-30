"use client";

import { useReview } from "@/lib/data/store";

interface Cell {
  key: string;
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}

/**
 * 오늘의 퍼널 KPI 스트립.
 * 6개 수치 중 "검수 대기" 하나만 민트 단색 블록 — 오늘 처리해야 할 작업량이
 * 이 화면에서 가장 중요한 수치이기 때문이다. 나머지는 캔버스 위 대형 숫자.
 *
 * ❗ 모르는 값은 `—` 다. 0 으로 채우면 "그만큼 없다" 로 읽힌다 (설계서 A.6).
 */
const num = (value: number | null): string => (value === null ? "—" : value.toLocaleString("ko-KR"));

export function MetricStrip() {
  const { metrics } = useReview();

  const cells: Cell[] = [
    { key: "raw", label: "수집 후보", value: num(metrics.rawCandidates) },
    { key: "analyzed", label: "상세 분석", value: num(metrics.analyzed) },
    { key: "queue", label: "검수 대기", value: num(metrics.reviewQueue), highlight: true },
    {
      key: "approved",
      label: "승인",
      value: num(metrics.approved),
      ...(metrics.approvalCap === null ? {} : { sub: `/${metrics.approvalCap}` }),
    },
    { key: "rejected", label: "제외", value: num(metrics.rejected) },
    { key: "final", label: "최종 리드", value: num(metrics.finalLeads) },
  ];

  return (
    <section
      aria-label="오늘의 퍼널 현황"
      className="flex items-stretch overflow-hidden rounded-card border border-line"
    >
      {cells.map((cell, i) => (
        <div
          key={cell.key}
          className={`flex flex-1 flex-col justify-center gap-1 px-6 py-4 ${
            cell.highlight
              ? "bg-mint text-ink"
              : i > 0
                ? "border-l border-line"
                : ""
          }`}
        >
          <span className={`k-label ${cell.highlight ? "text-ink/60" : ""}`}>
            {cell.label}
          </span>
          <span className="flex items-baseline gap-1">
            <span
              className={`display-num text-[38px] tabular-nums ${
                cell.highlight ? "text-ink" : "text-fg"
              }`}
            >
              {cell.value}
            </span>
            {cell.sub && (
              <span className={`font-mono text-[11px] tabular-nums ${cell.highlight ? "text-ink/60" : "text-fg-2"}`}>
                {cell.sub}
              </span>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}
