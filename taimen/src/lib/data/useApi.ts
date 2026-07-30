"use client";

import { useCallback, useEffect, useState, type DependencyList } from "react";
import { ApiError } from "./client";

/**
 * 엔드포인트 하나를 읽는 최소 훅.
 *
 * ❗ **실패를 빈 데이터로 뭉개지 않는다.** 화면은 "비어 있음"(정상)과 "못 읽었음"(고쳐야 할
 *    상태)을 구분해야 한다. 에러를 삼키고 `[]` 를 그리면 운영자는 데이터가 없다고 믿는다.
 *
 * ❗ `meta` 를 함께 돌려준다. `/api/runs/:id` 의 `failedJobsVisible` 처럼 **볼 수 없다는
 *    사실**이 meta 에만 있는 경우가 있고, 그걸 버리면 "실패한 잡이 없다" 로 오해한다.
 */
export interface AsyncState<T> {
  data: T | null;
  meta: Record<string, unknown> | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

const asApiError = (err: unknown): ApiError =>
  err instanceof ApiError ? err : new ApiError(0, "unknown", "알 수 없는 오류가 발생했습니다.");

export function useApi<T>(
  load: () => Promise<{ data: T; meta?: Record<string, unknown> }>,
  deps: DependencyList,
): AsyncState<T> {
  const [state, setState] = useState<Omit<AsyncState<T>, "reload">>({
    data: null,
    meta: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    // 응답이 늦게 도착한 이전 요청이 새 결과를 덮어쓰지 못하게 한다.
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    load()
      .then((res) => {
        if (alive) setState({ data: res.data, meta: res.meta ?? null, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (alive) setState({ data: null, meta: null, error: asApiError(err), loading: false });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { ...state, reload };
}
