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
import { api, ApiError, type ApiSettingRow } from "./client";
import { leads as leadFixture, reviewItems as reviewFixture, runs as runFixture, todayMetrics } from "./fixtures";
import { kstDate } from "./format";
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

/**
 * 검수 목록 밖의 운영 컨텍스트 — 헤더의 실행 ID·비용·쿼터와 승인 상한.
 *
 * ❗ 전부 `null` 을 허용한다. 값이 없는 이유가 셋이나 되고(엔드포인트 부재 · 권한 없음 ·
 *    아직 로딩 중), 어느 쪽이든 0 으로 보여 주면 안 된다.
 */
export interface OpsSnapshot {
  latestRunId: string | null;
  latestRunStatus: string | null;
  /** `targets.final_max` — 일 승인 상한. */
  approvalCap: number | null;
  /** 오늘 누적 비용. admin 이 아니면 `null` 이고 `costsForbidden` 이 true 다. */
  todayKrw: number | null;
  naverQuotaPct: number | null;
  /** 오늘 run 의 `counts` 스냅샷. 오늘 실행이 없으면 `null`. */
  todayRawCandidates: number | null;
  todayAnalyzed: number | null;
  /** `decided_at` 이 오늘(KST)인 제외 건수. 목록 limit 초과 시 하한값. */
  rejectedToday: number | null;
  /** 비용·쿼터를 볼 권한이 없다 (admin 전용). "0 원" 과 구분해야 한다. */
  costsForbidden: boolean;
}

const emptyOps: OpsSnapshot = {
  latestRunId: null,
  latestRunStatus: null,
  approvalCap: null,
  todayKrw: null,
  naverQuotaPct: null,
  todayRawCandidates: null,
  todayAnalyzed: null,
  rejectedToday: null,
  costsForbidden: false,
};

/** fixture 모드에서도 헤더가 비지 않게 한다 — 서버 없이 화면을 보는 경로를 유지한다. */
const fixtureOps: OpsSnapshot = {
  latestRunId: runFixture[0]?.id ?? null,
  latestRunStatus: runFixture[0]?.status ?? null,
  approvalCap: todayMetrics.approvalCap,
  todayKrw: todayMetrics.costKrw,
  naverQuotaPct: todayMetrics.naverQuotaPct,
  todayRawCandidates: todayMetrics.rawCandidates,
  todayAnalyzed: todayMetrics.analyzed,
  rejectedToday: todayMetrics.rejected,
  costsForbidden: false,
};

interface ReviewState {
  items: ReviewItem[];
  leads: Lead[];
  ops: OpsSnapshot;
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
  | { type: "loaded"; items: ReviewItem[]; leads: Lead[]; ops: OpsSnapshot }
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
      return { ...state, items: action.items, leads: action.leads, ops: action.ops, loading: false };
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
  ops: DATA_SOURCE === "fixture" ? fixtureOps : emptyOps,
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

/**
 * 승인일 기준 "오늘" (Asia/Seoul).
 *
 * ❗ 브라우저 로컬 시간이 아니라 **서울 날짜**여야 한다. 승인 상한 카운터도 서울 날짜
 *    기준이므로(`(now() at time zone 'Asia/Seoul')::date`), 여기가 어긋나면 화면의
 *    "오늘 승인 3/50" 과 서버가 세는 값이 달라진다.
 */
export const seoulToday = (): string => kstDate(new Date());

const objectValue = (rows: ApiSettingRow[], key: string): Record<string, unknown> | undefined => {
  const row = rows.find((r) => r.key === key);
  const value = row?.value;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * 운영 컨텍스트를 모은다.
 *
 * ❗ 각 호출을 **개별로** 감싼다. 검수자 권한으로 `/api/costs` 는 403 이 오는데, 이걸
 *    Promise.all 로 묶어 한 번에 실패시키면 비용을 못 본다는 이유로 실행 ID·승인 상한까지
 *    사라진다. 실패한 항목만 `null` 로 남기고 나머지는 살린다.
 */
async function loadOps(): Promise<OpsSnapshot> {
  const [settings, runs, costs, rejectedRows] = await Promise.all([
    api.settings().then((r) => r.data).catch(() => null),
    api.runs(1).then((r) => r.data).catch(() => null),
    api
      .costs()
      .then((r) => ({ data: r.data, forbidden: false }))
      .catch((err) => ({ data: null, forbidden: err instanceof ApiError && err.status === 403 })),
    api.reviewList("rejected").then((r) => r.data).catch(() => null),
  ]);

  const latest = runs?.[0];
  const targets = settings ? (settings.effective["targets"] ?? {}) : {};
  const naverCap = finiteNumber(objectValue(settings?.rows ?? [], "quota")?.["naver_daily_cap"]);
  const naverUsed = costs.data
    ? costs.data.providers
        .filter((p) => p.provider.startsWith("naver"))
        .reduce((sum, p) => sum + p.qty, 0)
    : null;

  const today = seoulToday();
  // ❗ 오늘 run 의 counts 만 퍼널에 쓴다. 어제 실행의 수집량을 오늘 것처럼 보여 주지 않는다.
  const todayCounts = latest && kstDate(latest.run_date) === today ? latest.counts : {};

  return {
    latestRunId: latest?.id ?? null,
    latestRunStatus: latest?.status ?? null,
    approvalCap: finiteNumber(targets["finalMax"]),
    todayKrw: costs.data ? costs.data.todayKrw : null,
    // 분모를 모르면 비율도 모른다 — 0% 로 채우면 "여유가 충분하다" 로 읽힌다.
    naverQuotaPct:
      naverUsed !== null && naverCap !== null && naverCap > 0
        ? Math.round((naverUsed / naverCap) * 100)
        : null,
    todayRawCandidates: finiteNumber(todayCounts["raw_candidates"]),
    todayAnalyzed: finiteNumber(todayCounts["analyzed"]),
    rejectedToday:
      rejectedRows === null
        ? null
        : rejectedRows.filter((r) => r.decided_at !== null && seoulDate(r.decided_at) === today).length,
    costsForbidden: costs.forbidden,
  };
}

export function ReviewProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const refresh = useCallback(async (): Promise<void> => {
    if (DATA_SOURCE === "fixture") return;
    dispatch({ type: "loading", value: true });
    try {
      // 검수 목록·리드는 필수다 — 못 받으면 화면이 성립하지 않으므로 그대로 에러를 낸다.
      const [review, leads] = await Promise.all([api.reviewList("pending"), api.leads()]);
      // 운영 컨텍스트는 **보조**다. 실패해도 검수는 계속돼야 한다.
      const ops = await loadOps();
      dispatch({
        type: "loaded",
        items: review.data.map(mapListItem),
        leads: leads.data.map(mapLead),
        ops,
      });
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
        rejected: (todayMetrics.rejected ?? 0) + rejectedNow,
        finalLeads: todayMetrics.finalLeads + approvedNow,
      };
    }

    // ❗ 승인·최종 리드는 **오늘 승인분**이다. `/api/leads` 는 승인일 내림차순이라 오늘 건이
    //    맨 앞에 오고, 일 상한이 50 이므로 200건 페이지 안에서 오늘 것이 잘릴 일은 없다.
    const today = seoulToday();
    const approvedToday = state.leads.filter((lead) => lead.approvedAt === today).length;

    return {
      rawCandidates: state.ops.todayRawCandidates,
      analyzed: state.ops.todayAnalyzed,
      reviewQueue: pending,
      approved: approvedToday,
      rejected: state.ops.rejectedToday,
      finalLeads: approvedToday,
      approvalCap: state.ops.approvalCap,
      costKrw: state.ops.todayKrw,
      naverQuotaPct: state.ops.naverQuotaPct,
    };
  }, [state.items, state.leads, state.ops]);

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
