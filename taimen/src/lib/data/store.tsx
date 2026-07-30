"use client";

/**
 * 검수 스토어.
 *
 * 상태를 바꾸는 것은 **서버**다. 이 스토어는 화면 상태(커서·선택·드로어)만 직접 들고,
 * 승인·제외·이메일 입력은 API 를 호출하고 결과를 반영한다.
 *
 *   submitEmail → POST /api/review/:id/contact-email
 *   approve     → POST /api/review/:id/decision
 *   reject      → POST /api/review/:id/decision
 *   bulkReject  → POST /api/review/bulk-decision
 *
 * ❗ **낙관적 갱신을 하지 않는다.** 승인은 일 상한·업종 쿼터·MX 게이트에서 거절될 수 있고
 *    (409·422), 화면이 먼저 승인으로 바꿔 두면 실패한 승인이 성공처럼 보인다. 서버가
 *    확인해 준 뒤에 옮긴다.
 *
 * ❗ 데이터 소스는 `NEXT_PUBLIC_LEADOPS_DATA_SOURCE` 가 정한다. 기본값은 `api` 이고,
 *    `fixture` 로 두면 서버 없이 화면만 볼 수 있다 (그 경우 승인은 화면에서만 일어난다).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { api, ApiError } from "./client";
import { leads as leadFixture, reviewItems as reviewFixture, todayMetrics } from "./fixtures";
import { mapDetail, mapLead, mapListItem } from "./mapper";
import type { EmailType, EnteredEmail, Lead, ReviewItem, TodayMetrics } from "./types";

export type DataSource = "api" | "fixture";

export const DATA_SOURCE: DataSource =
  process.env["NEXT_PUBLIC_LEADOPS_DATA_SOURCE"] === "fixture" ? "fixture" : "api";

export interface Notice {
  kind: "error" | "info";
  code: string;
  message: string;
}

interface ReviewState {
  items: ReviewItem[];
  leads: Lead[];
  cursor: number;
  selected: Set<string>;
  openId: string | null;
  focusEmail: number;
  loading: boolean;
  /** 진행 중인 서버 작업. 버튼을 잠그는 데 쓴다. */
  busy: string | null;
  notice: Notice | null;
}

type Action =
  | { type: "cursor"; delta: number; visibleIds: string[] }
  | { type: "toggleSelect"; id: string }
  | { type: "clearSelect" }
  | { type: "open"; id: string | null }
  | { type: "focusEmail"; id: string }
  | { type: "loading"; value: boolean }
  | { type: "busy"; value: string | null }
  | { type: "notice"; value: Notice | null }
  | { type: "loaded"; items: ReviewItem[]; leads: Lead[] }
  | { type: "patchItem"; id: string; patch: Partial<ReviewItem> };

function reducer(state: ReviewState, action: Action): ReviewState {
  switch (action.type) {
    case "cursor": {
      const max = action.visibleIds.length - 1;
      return { ...state, cursor: Math.min(Math.max(state.cursor + action.delta, 0), Math.max(max, 0)) };
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
    case "loading":
      return { ...state, loading: action.value };
    case "busy":
      return { ...state, busy: action.value };
    case "notice":
      return { ...state, notice: action.value };
    case "loaded":
      return { ...state, items: action.items, leads: action.leads, loading: false };
    case "patchItem":
      return {
        ...state,
        items: state.items.map((it) => (it.id === action.id ? { ...it, ...action.patch } : it)),
      };
  }
}

const initialState: ReviewState = {
  items: DATA_SOURCE === "fixture" ? reviewFixture : [],
  leads: DATA_SOURCE === "fixture" ? leadFixture : [],
  cursor: 0,
  selected: new Set(),
  openId: null,
  focusEmail: 0,
  loading: DATA_SOURCE === "api",
  busy: null,
  notice: null,
};

export interface EmailInput {
  address: string;
  emailType: EmailType;
  contactPageId: string;
}

export interface StoreActions {
  refresh(): Promise<void>;
  /** 드로어를 열고 상세를 받아 온다 (nonce 도 여기서 발급된다). */
  openItem(id: string): Promise<void>;
  submitEmail(id: string, input: EmailInput): Promise<EnteredEmail | undefined>;
  approve(id: string): Promise<boolean>;
  reject(id: string, reason: string): Promise<boolean>;
  bulkReject(ids: string[], reason: string): Promise<number>;
  dismissNotice(): void;
}

interface StoreValue {
  state: ReviewState;
  dispatch: (action: Action) => void;
  metrics: TodayMetrics;
  actions: StoreActions;
  source: DataSource;
}

const StoreContext = createContext<StoreValue | null>(null);

/** 서버 오류를 화면 문구로 옮긴다. 규칙 위반과 우리 쪽 오류를 구분해 보여 준다. */
function toNotice(err: unknown): Notice {
  if (err instanceof ApiError) {
    return { kind: "error", code: err.code, message: err.message };
  }
  return { kind: "error", code: "unknown", message: "알 수 없는 오류가 발생했습니다." };
}

export function ReviewProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const refresh = useCallback(async (): Promise<void> => {
    if (DATA_SOURCE === "fixture") return;
    dispatch({ type: "loading", value: true });
    try {
      const [review, leads] = await Promise.all([api.reviewList("pending"), api.leads()]);
      dispatch({ type: "loaded", items: review.data.map(mapListItem), leads: leads.data.map(mapLead) });
      dispatch({ type: "notice", value: null });
    } catch (err) {
      dispatch({ type: "loading", value: false });
      dispatch({ type: "notice", value: toNotice(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openItem = useCallback(async (id: string): Promise<void> => {
    dispatch({ type: "open", id });
    if (DATA_SOURCE === "fixture") return;
    try {
      const detail = await api.reviewDetail(id);
      dispatch({ type: "patchItem", id, patch: mapDetail(detail.data) });
    } catch (err) {
      dispatch({ type: "notice", value: toNotice(err) });
    }
  }, []);

  const submitEmail = useCallback(
    async (id: string, input: EmailInput): Promise<EnteredEmail | undefined> => {
      if (DATA_SOURCE === "fixture") {
        const email: EnteredEmail = {
          address: input.address,
          type: input.emailType,
          sourcePath: "",
          verification: input.address.includes("fail") ? "failed" : "mx_ok",
        };
        dispatch({ type: "patchItem", id, patch: { email } });
        return email;
      }

      dispatch({ type: "busy", value: `email:${id}` });
      try {
        const current = state.items.find((it) => it.id === id);
        const nonce = current?.nonce;
        if (!nonce) throw new ApiError(400, "no_nonce", "검수 화면을 다시 열어 주세요.");

        const result = await api.submitContactEmail(id, { ...input, nonce });
        const email: EnteredEmail = {
          id: result.data.emailId,
          address: input.address,
          type: input.emailType,
          sourcePath: "",
          verification: result.data.mxOk ? "mx_ok" : result.data.dnsOk ? "dns_ok" : "failed",
          ...(result.data.mxHosts.length > 0 ? { mxHosts: result.data.mxHosts } : {}),
          ...(result.data.implicitMx ? { implicitMx: true } : {}),
          ...(result.data.reason === undefined ? {} : { reason: result.data.reason }),
        };
        // nonce 는 1회용이다. 소비했으므로 지운다 — 다시 입력하려면 화면을 다시 열어야 한다.
        dispatch({ type: "patchItem", id, patch: { email, ...(nonce ? { nonce: undefined } : {}) } });
        if (!result.data.mxOk) {
          dispatch({
            type: "notice",
            value: {
              kind: "error",
              code: "mx_failed",
              message: `MX 검증을 통과하지 못했습니다 (${result.data.reason ?? "확인 불가"}). 승인할 수 없습니다.`,
            },
          });
        }
        return email;
      } catch (err) {
        dispatch({ type: "notice", value: toNotice(err) });
        return undefined;
      } finally {
        dispatch({ type: "busy", value: null });
      }
    },
    [state.items],
  );

  const decide = useCallback(
    async (id: string, status: "approved" | "rejected", extra: { reason?: string; emailId?: string }): Promise<boolean> => {
      if (DATA_SOURCE === "fixture") {
        dispatch({
          type: "patchItem",
          id,
          patch: { status, ...(extra.reason === undefined ? {} : { rejectReason: extra.reason }) },
        });
        dispatch({ type: "open", id: null });
        return true;
      }

      dispatch({ type: "busy", value: `decide:${id}` });
      try {
        await api.decide(id, { status, ...extra });
        dispatch({ type: "open", id: null });
        // ❗ 낙관적 갱신 대신 다시 읽는다. 승인 카운터·리드는 서버가 만든 결과다.
        await refresh();
        return true;
      } catch (err) {
        dispatch({ type: "notice", value: toNotice(err) });
        return false;
      } finally {
        dispatch({ type: "busy", value: null });
      }
    },
    [refresh],
  );

  const approve = useCallback(
    async (id: string): Promise<boolean> => {
      const item = state.items.find((it) => it.id === id);
      const emailId = item?.email?.id;
      if (DATA_SOURCE === "api" && !emailId) {
        dispatch({
          type: "notice",
          value: { kind: "error", code: "email_required", message: "MX 검증을 통과한 이메일을 먼저 입력하세요." },
        });
        return false;
      }
      return decide(id, "approved", emailId === undefined ? {} : { emailId });
    },
    [decide, state.items],
  );

  const reject = useCallback((id: string, reason: string) => decide(id, "rejected", { reason }), [decide]);

  const bulkReject = useCallback(
    async (ids: string[], reason: string): Promise<number> => {
      if (DATA_SOURCE === "fixture") {
        for (const id of ids) {
          dispatch({ type: "patchItem", id, patch: { status: "rejected", rejectReason: reason } });
        }
        dispatch({ type: "clearSelect" });
        return ids.length;
      }

      dispatch({ type: "busy", value: "bulk" });
      try {
        const result = await api.bulkReject(ids, reason);
        const failed = result.data.filter((r) => !r.ok);
        dispatch({ type: "clearSelect" });
        await refresh();
        if (failed.length > 0) {
          // 부분 실패를 조용히 넘기지 않는다.
          dispatch({
            type: "notice",
            value: {
              kind: "error",
              code: "bulk_partial",
              message: `${ids.length}건 중 ${failed.length}건이 처리되지 않았습니다.`,
            },
          });
        }
        return result.data.length - failed.length;
      } catch (err) {
        dispatch({ type: "notice", value: toNotice(err) });
        return 0;
      } finally {
        dispatch({ type: "busy", value: null });
      }
    },
    [refresh],
  );

  const dismissNotice = useCallback(() => dispatch({ type: "notice", value: null }), []);

  const metrics = useMemo<TodayMetrics>(() => {
    const pending = state.items.filter((it) => it.status === "pending").length;
    if (DATA_SOURCE === "fixture") {
      const approvedNow = state.items.filter((it) => it.status === "approved").length;
      const rejectedNow = state.items.filter((it) => it.status === "rejected").length;
      return {
        ...todayMetrics,
        reviewQueue: pending,
        approved: todayMetrics.approved + approvedNow,
        rejected: todayMetrics.rejected + rejectedNow,
        finalLeads: todayMetrics.finalLeads + approvedNow,
      };
    }
    // ⚠️ 퍼널 상단(수집·분석 건수)과 비용·쿼터는 아직 API 가 주지 않는다.
    //    /api/runs·/api/costs 가 생기면 여기서 읽는다. 지금은 0 으로 두고 화면이
    //    "모름" 을 그대로 보여 준다 — 픽스처 숫자를 실데이터처럼 섞지 않는다.
    return {
      rawCandidates: 0,
      analyzed: 0,
      reviewQueue: pending,
      approved: state.leads.length,
      rejected: 0,
      finalLeads: state.leads.length,
      approvalCap: todayMetrics.approvalCap,
      costKrw: 0,
      naverQuotaPct: 0,
    };
  }, [state.items, state.leads]);

  const actions = useMemo<StoreActions>(
    () => ({ refresh, openItem, submitEmail, approve, reject, bulkReject, dismissNotice }),
    [refresh, openItem, submitEmail, approve, reject, bulkReject, dismissNotice],
  );

  const value = useMemo(
    () => ({ state, dispatch, metrics, actions, source: DATA_SOURCE }),
    [state, metrics, actions],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useReview(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useReview must be used within ReviewProvider");
  return ctx;
}
