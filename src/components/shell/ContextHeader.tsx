import type { ReactNode } from "react";

/**
 * 상단 컨텍스트 헤더. 페이지 제목 + 우측 컨텍스트 슬롯.
 * 절제된 1px 하단 라인만 — 카드·배경 블록 없음.
 */
export function ContextHeader({
  kicker,
  title,
  right,
}: {
  kicker?: string;
  title: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-8">
      <div className="flex items-baseline gap-3">
        {kicker && <span className="mono-label text-mint">{kicker}</span>}
        <h1 className="text-[15px] font-semibold text-fg">{title}</h1>
      </div>
      {right && <div className="flex items-center gap-5">{right}</div>}
    </header>
  );
}

/** 헤더 우측 모노 통계 조각 (실행 ID · 비용 · 쿼터 등). */
export function HeaderStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="mono-label text-[9px]">{label}</span>
      <span className={`font-mono text-[11px] font-semibold tabular-nums ${accent ? "text-mint" : "text-fg-3"}`}>
        {value}
      </span>
    </span>
  );
}
