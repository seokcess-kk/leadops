import type { CompetitorRow } from "@/lib/data/types";

/**
 * 경쟁사 3곳 비교. 당사 행은 민트 1px 좌측 라인으로 표시.
 * 유효 경쟁사 2곳 미만이면 격차 축은 unavailable — 허위 취약점을 만들지 않는다 (R11).
 */
export function CompetitorComparison({
  rows,
  available,
}: {
  rows: CompetitorRow[];
  available: boolean;
}) {
  if (!available) {
    return (
      <p className="rounded-block border border-line bg-subtle px-4 py-3 text-xs leading-relaxed text-fg-2">
        유효 경쟁사 2곳 미만 — 경쟁 격차 축 <span className="font-mono text-[10px] uppercase">unavailable</span>.
        점수 재정규화 없이 해당 축을 제외하고 산정했습니다.
      </p>
    );
  }

  const th = "mono-label px-2 py-1.5 text-right text-[8px] font-medium";
  /** ❗ 모르는 값은 0 이 아니라 `—` 다. 0 으로 쓰면 "경쟁사가 안 한다" 로 읽힌다. */
  const cell = (value: number | null, fmt: (n: number) => string): string =>
    value === null ? "—" : fmt(value);

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-row">
          <th className={`${th} text-left`}>업체</th>
          <th className={th}>ORS</th>
          <th className={th}>자산</th>
          <th className={th}>60일</th>
          <th className={th}>활동</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.name}
            className={`border-b border-row text-[12px] last:border-b-0 ${
              row.isSelf ? "border-l border-l-mint bg-subtle font-medium text-fg" : "text-fg-2"
            } ${row.isValid ? "" : "opacity-50"}`}
            title={row.isValid ? undefined : "분석되지 않은 경쟁사 — 지표 없음"}
          >
            <td className="max-w-[150px] truncate px-2 py-1.5">{row.name}</td>
            <td className="px-2 py-1.5 text-right font-mono text-[11px] tabular-nums">
              {cell(row.ors, (n) => `${(n * 100).toFixed(0)}%`)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-[11px] tabular-nums">
              {cell(row.officialAssets, (n) => String(n))}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-[11px] tabular-nums">
              {cell(row.recency60d, (n) => String(n))}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-[11px] tabular-nums">
              {cell(row.channelActivity, (n) => n.toFixed(1))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
