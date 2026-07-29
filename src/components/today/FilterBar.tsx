"use client";

import { Button } from "@/components/ui/Button";
import { INDUSTRY_LABEL, type Industry } from "@/lib/data/types";

export interface ReviewFilter {
  industry: Industry | "all";
  query: string;
  minScore: number;
}

/**
 * 필터 바 — 절제 다크 UI. 인풋은 2px 라디우스 "타자기 태그" 스타일.
 * 일괄 액션은 설계서 §8.2에 따라 "제외"만 존재한다 (일괄 승인 금지).
 */
export function FilterBar({
  filter,
  onChange,
  selectedCount,
  onBulkReject,
}: {
  filter: ReviewFilter;
  onChange: (next: ReviewFilter) => void;
  selectedCount: number;
  onBulkReject: () => void;
}) {
  const inputCls =
    "h-8 rounded-tag border border-line bg-canvas px-3 text-[13px] text-fg placeholder:text-fg-2 focus:border-mint focus:outline-none transition-colors duration-150";

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <select
          aria-label="업종 필터"
          className={`${inputCls} appearance-none pr-8`}
          value={filter.industry}
          onChange={(e) => onChange({ ...filter, industry: e.target.value as ReviewFilter["industry"] })}
        >
          <option value="all">업종 전체</option>
          {(Object.keys(INDUSTRY_LABEL) as Industry[]).map((key) => (
            <option key={key} value={key}>
              {INDUSTRY_LABEL[key]}
            </option>
          ))}
        </select>
        <input
          aria-label="업체명·지역 검색"
          className={`${inputCls} w-[220px]`}
          placeholder="업체명·지역 검색"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
        />
        <select
          aria-label="최소 점수"
          className={`${inputCls} appearance-none pr-8`}
          value={filter.minScore}
          onChange={(e) => onChange({ ...filter, minScore: Number(e.target.value) })}
        >
          <option value={0}>점수 전체</option>
          <option value={60}>60점 이상</option>
          <option value={70}>70점 이상</option>
          <option value={80}>80점 이상</option>
        </select>
      </div>

      <div className="flex items-center gap-4">
        <span className="k-label hidden xl:block">
          J/K 이동 · Space 선택 · X 제외 · E 이메일 · Enter 상세
        </span>
        <Button size="sm" disabled={selectedCount === 0} onClick={onBulkReject}>
          선택 {selectedCount}건 제외
        </Button>
      </div>
    </div>
  );
}
