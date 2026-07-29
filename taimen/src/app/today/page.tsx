"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ContextHeader, HeaderStat } from "@/components/shell/ContextHeader";
import { DetailDrawer } from "@/components/drawer/DetailDrawer";
import { FilterBar, type ReviewFilter } from "@/components/today/FilterBar";
import { LeadTable } from "@/components/today/LeadTable";
import { MetricStrip } from "@/components/today/MetricStrip";
import { RejectDialog } from "@/components/today/RejectDialog";
import { runs, TODAY } from "@/lib/data/fixtures";
import { useReview } from "@/lib/data/store";
import { INDUSTRY_LABEL } from "@/lib/data/types";

/**
 * 오늘의 검수 (Scout) — 기본 진입 화면.
 * 키보드 흐름 (설계서 §8.2): j/k 이동 · Space 선택 · x 제외 · e 이메일 폼 · Enter 상세.
 * 일괄 처리는 제외만 — 승인은 MX 통과 이메일이 필요하므로 개별 처리.
 */
export default function TodayPage() {
  const { state, dispatch, metrics } = useReview();
  const [filter, setFilter] = useState<ReviewFilter>({ industry: "all", query: "", minScore: 0 });
  const [reject, setReject] = useState<{ ids: string[]; label: string } | null>(null);

  const visible = useMemo(
    () =>
      state.items.filter((item) => {
        if (item.status !== "pending") return false;
        if (filter.industry !== "all" && item.industry !== filter.industry) return false;
        if (item.score.total < filter.minScore) return false;
        if (filter.query) {
          const q = filter.query.toLowerCase();
          const hay = `${item.companyName} ${item.regionSido} ${item.regionSigungu} ${INDUSTRY_LABEL[item.industry]}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [state.items, filter],
  );

  const visibleIds = useMemo(() => visible.map((item) => item.id), [visible]);
  const cursor = Math.min(state.cursor, Math.max(visible.length - 1, 0));
  const cursorItem = visible[cursor];
  const openItem = state.openId ? state.items.find((item) => item.id === state.openId) : undefined;

  const openReject = useCallback((ids: string[], label: string) => {
    setReject({ ids, label });
  }, []);

  // 딥링크: /today?open=<id> 로 특정 리드 드로어를 바로 연다 (검수 항목 공유용)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("open");
    if (id) dispatch({ type: "open", id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 전역 키보드 — 입력 필드·다이얼로그에서는 비활성
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (reject) return;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable) return;

      switch (e.key) {
        case "j":
          dispatch({ type: "cursor", delta: 1, visibleIds });
          if (state.openId && visible[Math.min(cursor + 1, visible.length - 1)]) {
            dispatch({ type: "open", id: visible[Math.min(cursor + 1, visible.length - 1)].id });
          }
          break;
        case "k":
          dispatch({ type: "cursor", delta: -1, visibleIds });
          if (state.openId && visible[Math.max(cursor - 1, 0)]) {
            dispatch({ type: "open", id: visible[Math.max(cursor - 1, 0)].id });
          }
          break;
        case " ":
          e.preventDefault();
          if (cursorItem) dispatch({ type: "toggleSelect", id: cursorItem.id });
          break;
        case "x":
          if (cursorItem) openReject([cursorItem.id], cursorItem.companyName);
          break;
        case "e":
          if (cursorItem) dispatch({ type: "focusEmail", id: cursorItem.id });
          break;
        case "Enter":
          if (cursorItem && !state.openId) dispatch({ type: "open", id: cursorItem.id });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, visibleIds, visible, cursor, cursorItem, state.openId, reject, openReject]);

  const latestRun = runs[0];

  return (
    <>
      <ContextHeader
        kicker="Scout"
        title="오늘의 검수"
        right={
          <>
            <HeaderStat label="Run" value={latestRun.id.toUpperCase()} />
            <HeaderStat label="Cost" value={`₩${metrics.costKrw.toLocaleString("ko-KR")}`} />
            <HeaderStat label="Quota" value={`${metrics.naverQuotaPct}%`} accent={metrics.naverQuotaPct > 80} />
            <HeaderStat label="Date" value={TODAY} />
          </>
        }
      />
      <main className="flex flex-1 flex-col gap-5 p-8">
        <MetricStrip />
        <FilterBar
          filter={filter}
          onChange={setFilter}
          selectedCount={state.selected.size}
          onBulkReject={() =>
            openReject(Array.from(state.selected), `선택한 ${state.selected.size}개 업체`)
          }
        />
        <LeadTable
          items={visible}
          cursor={cursor}
          selected={state.selected}
          onOpen={(id) => dispatch({ type: "open", id })}
          onToggle={(id) => dispatch({ type: "toggleSelect", id })}
          onApprove={(id) => dispatch({ type: "approve", id })}
          onReject={(id) => {
            const item = state.items.find((it) => it.id === id);
            if (item) openReject([id], item.companyName);
          }}
          onCursor={(index) => dispatch({ type: "cursor", delta: index - cursor, visibleIds })}
        />
      </main>

      {openItem && (
        <DetailDrawer
          item={openItem}
          focusEmail={state.focusEmail}
          onClose={() => dispatch({ type: "open", id: null })}
          onApprove={() => dispatch({ type: "approve", id: openItem.id })}
          onReject={() => openReject([openItem.id], openItem.companyName)}
          onSubmitEmail={(email) => dispatch({ type: "submitEmail", id: openItem.id, email })}
        />
      )}

      {reject && (
        <RejectDialog
          targetLabel={reject.label}
          onClose={() => setReject(null)}
          onConfirm={(reason) => {
            if (reject.ids.length === 1) {
              dispatch({ type: "reject", id: reject.ids[0], reason });
            } else {
              dispatch({ type: "bulkReject", ids: reject.ids, reason });
            }
            setReject(null);
          }}
        />
      )}
    </>
  );
}
