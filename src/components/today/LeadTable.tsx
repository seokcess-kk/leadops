"use client";

import { useEffect, useRef } from "react";
import { LeadScore } from "@/components/ui/LeadScore";
import { INDUSTRY_LABEL, type ReviewItem } from "@/lib/data/types";

/**
 * 검수 테이블 — 이 제품의 심장.
 * 카드 그리드가 아니라 밀도 높은 테이블: 행 44px, 1px 라인 구분,
 * 호버는 배경 미세 변화만. 리프트·확대·강한 애니메이션 없음.
 * 승인 버튼은 MX 통과 이메일이 있어야 활성화된다 (설계서 승인 게이트).
 */
export function LeadTable({
  items,
  cursor,
  selected,
  onOpen,
  onToggle,
  onApprove,
  onReject,
  onCursor,
}: {
  items: ReviewItem[];
  cursor: number;
  selected: Set<string>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onCursor: (index: number) => void;
}) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // 키보드 커서 이동 시 해당 행을 뷰포트 안으로
  useEffect(() => {
    const row = bodyRef.current?.children[cursor] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const th = "px-3 py-2.5 text-left k-label whitespace-nowrap";

  return (
    <div className="overflow-x-auto rounded-card border border-line">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-subtle">
          <tr className="border-b border-line">
            <th className={`${th} w-9 pl-4`}>
              <span className="sr-only">선택</span>
            </th>
            <th className={th}>업체명</th>
            <th className={th}>업종</th>
            <th className={th}>지역</th>
            <th className={th}>이메일</th>
            <th className={th}>리드 점수</th>
            <th className={th}>핵심 취약점</th>
            <th className={th}>주력 추천</th>
            <th className={th}>신뢰도</th>
            <th className={`${th} w-[72px] text-center`}>승인</th>
            <th className={`${th} w-[72px] pr-4 text-center`}>제외</th>
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {items.map((item, i) => {
            const isCursor = i === cursor;
            const mxOk = item.email?.verification === "mx_ok";
            const topWeakness = item.weaknesses[0];
            return (
              <tr
                key={item.id}
                aria-selected={isCursor}
                onClick={() => {
                  onCursor(i);
                  onOpen(item.id);
                }}
                className={`h-11 cursor-pointer border-b border-row transition-colors duration-100 last:border-b-0 ${
                  isCursor
                    ? "border-l border-l-mint bg-subtle"
                    : "hover:bg-subtle"
                }`}
              >
                <td className="pl-4" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`${item.companyName} 선택`}
                    checked={selected.has(item.id)}
                    onChange={() => onToggle(item.id)}
                    className="h-3.5 w-3.5 cursor-pointer appearance-none rounded-tag border border-line-strong bg-transparent checked:border-mint checked:bg-mint"
                  />
                </td>
                <td className="max-w-[180px] truncate px-3 font-medium text-fg">
                  {item.companyName}
                </td>
                <td className="whitespace-nowrap px-3 text-fg-2">{INDUSTRY_LABEL[item.industry]}</td>
                <td className="whitespace-nowrap px-3 text-fg-2">
                  {item.regionSido} {item.regionSigungu}
                </td>
                <td className="max-w-[170px] truncate px-3">
                  {item.email ? (
                    <span className="flex items-center gap-1.5 text-xs text-fg-3">
                      <span
                        aria-hidden
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          mxOk ? "bg-mint" : item.email.verification === "failed" ? "bg-violet-bright" : "bg-fg-2"
                        }`}
                      />
                      {item.email.address}
                    </span>
                  ) : (
                    <span className="k-label">미입력</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3">
                  <LeadScore score={item.score} />
                </td>
                <td className="max-w-[190px] px-3">
                  {topWeakness && (
                    <span className="flex items-center gap-1.5 truncate text-xs text-fg-3">
                      <span
                        aria-hidden
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          topWeakness.severity === "high" ? "bg-violet-bright" : "bg-fg-2"
                        }`}
                      />
                      <span className="truncate">{topWeakness.label}</span>
                      {item.weaknesses.length > 1 && (
                        <span className="font-mono text-[10px] text-fg-2">+{item.weaknesses.length - 1}</span>
                      )}
                    </span>
                  )}
                </td>
                <td className="max-w-[170px] truncate px-3 text-xs text-fg-3">{item.primaryService}</td>
                <td className="whitespace-nowrap px-3">
                  <span className="font-mono text-[11px] tabular-nums text-fg-3">
                    {item.score.confidence}
                    <span className="text-fg-2">/15</span>
                  </span>
                </td>
                <td className="px-2 text-center" onClick={(e) => e.stopPropagation()}>
                  <button
                    disabled={!mxOk}
                    onClick={() => onApprove(item.id)}
                    title={mxOk ? "승인" : "MX 검증을 통과한 이메일이 필요합니다"}
                    className="h-7 cursor-pointer rounded-full bg-mint px-3 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-white disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    승인
                  </button>
                </td>
                <td className="pr-4 text-center" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => onReject(item.id)}
                    className="h-7 cursor-pointer rounded-full bg-surface px-3 text-xs text-fg-3 transition-colors duration-150 hover:bg-[#3a3a3a]"
                  >
                    제외
                  </button>
                </td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr>
              <td colSpan={11} className="px-4 py-16 text-center">
                <span className="k-label">검수 대기 항목 없음 — 필터를 확인하세요</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
