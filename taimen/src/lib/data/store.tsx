"use client";

/**
 * 검수 스토어.
 *
 * 설계서 §7.2 API 의미론을 클라이언트 상태로 재현한다:
 *  - 승인은 MX 검증(mx_ok)을 통과한 이메일이 있어야만 가능 (결론 A · 검수 승인 게이트)
 *  - 일괄 처리는 "제외"만 허용 (§8.2 — 승인은 개별 처리)
 *  - 제외는 사유가 필수이며 cooldown 후 재평가 풀로 복귀
 *
 * 데이터 소스는 fixture 모드다 (fixtures.ts 참고). API 서버가 생기면
 * 이 파일의 전이 함수를 §7.2 엔드포인트 호출로 교체한다:
 *  submitEmail → POST /api/review/:id/contact-email
 *  decide      → POST /api/review/:id/decision
 *  bulkReject  → POST /api/review/bulk-decision
 */

import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import { leads as leadFixture, reviewItems as reviewFixture, todayMetrics } from "./fixtures";
import type { EnteredEmail, Lead, ReviewItem, TodayMetrics } from "./types";

interface ReviewState {
  items: ReviewItem[];
  leads: Lead[];
  /** j/k 커서 (테이블 행 인덱스) */
  cursor: number;
  /** Space 로 토글하는 선택 집합 — 일괄 제외 전용 */
  selected: Set<string>;
  /** 드로어에 열린 항목 id */
  openId: string | null;
  /** 드로어를 열 때 이메일 폼으로 바로 포커스할지 (e 키) */
  focusEmail: number;
}

type Action =
  | { type: "cursor"; delta: number; visibleIds: string[] }
  | { type: "toggleSelect"; id: string }
  | { type: "clearSelect" }
  | { type: "open"; id: string | null }
  | { type: "focusEmail"; id: string }
  | { type: "submitEmail"; id: string; email: EnteredEmail }
  | { type: "approve"; id: string }
  | { type: "reject"; id: string; reason: string }
  | { type: "bulkReject"; ids: string[]; reason: string };

function toLead(item: ReviewItem): Lead {
  return {
    id: `ld-${item.id}`,
    companyName: item.companyName,
    industry: item.industry,
    region: `${item.regionSido} ${item.regionSigungu}`,
    email: item.email?.address ?? "",
    score: item.score.total,
    approvedAt: "2026-07-29",
    status: "READY",
  };
}

function reducer(state: ReviewState, action: Action): ReviewState {
  switch (action.type) {
    case "cursor": {
      const max = action.visibleIds.length - 1;
      const next = Math.min(Math.max(state.cursor + action.delta, 0), Math.max(max, 0));
      return { ...state, cursor: next };
    }
    case "toggleSelect": {
      const selected = new Set(state.selected);
      if (selected.has(action.id)) selected.delete(action.id);
      else selected.add(action.id);
      return { ...state, selected };
    }
    case "clearSelect":
      return { ...state, selected: new Set() };
    case "open":
      return { ...state, openId: action.id };
    case "focusEmail":
      return { ...state, openId: action.id, focusEmail: state.focusEmail + 1 };
    case "submitEmail":
      return {
        ...state,
        items: state.items.map((it) =>
          it.id === action.id ? { ...it, email: action.email } : it,
        ),
      };
    case "approve": {
      const item = state.items.find((it) => it.id === action.id);
      // 승인 게이트: MX 통과 이메일 없이는 상태 전이 자체를 거부한다
      if (!item || item.email?.verification !== "mx_ok") return state;
      return {
        ...state,
        items: state.items.map((it) =>
          it.id === action.id ? { ...it, status: "approved" as const } : it,
        ),
        leads: [toLead(item), ...state.leads],
        openId: null,
      };
    }
    case "reject":
      return {
        ...state,
        items: state.items.map((it) =>
          it.id === action.id
            ? { ...it, status: "rejected" as const, rejectReason: action.reason }
            : it,
        ),
        openId: state.openId === action.id ? null : state.openId,
      };
    case "bulkReject": {
      const ids = new Set(action.ids);
      return {
        ...state,
        items: state.items.map((it) =>
          ids.has(it.id) && it.status === "pending"
            ? { ...it, status: "rejected" as const, rejectReason: action.reason }
            : it,
        ),
        selected: new Set(),
      };
    }
  }
}

const initialState: ReviewState = {
  items: reviewFixture,
  leads: leadFixture,
  cursor: 0,
  selected: new Set(),
  openId: null,
  focusEmail: 0,
};

interface StoreValue {
  state: ReviewState;
  dispatch: (action: Action) => void;
  metrics: TodayMetrics;
}

const StoreContext = createContext<StoreValue | null>(null);

export function ReviewProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const metrics = useMemo<TodayMetrics>(() => {
    const approvedNow = state.items.filter((it) => it.status === "approved").length;
    const rejectedNow = state.items.filter((it) => it.status === "rejected").length;
    return {
      ...todayMetrics,
      reviewQueue: state.items.filter((it) => it.status === "pending").length,
      approved: todayMetrics.approved + approvedNow,
      rejected: todayMetrics.rejected + rejectedNow,
      finalLeads: todayMetrics.finalLeads + approvedNow,
    };
  }, [state.items]);

  const value = useMemo(() => ({ state, dispatch, metrics }), [state, metrics]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useReview(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useReview must be used within ReviewProvider");
  return ctx;
}
