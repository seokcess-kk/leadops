"use client";

import { useCallback, useMemo, useState } from "react";
import { ContextHeader, HeaderStat } from "@/components/shell/ContextHeader";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState } from "@/components/ui/EmptyState";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { Notice } from "@/components/ui/Notice";
import { StageTag } from "@/components/ui/StatusTag";
import { SignalStream, type StreamEvent } from "@/components/stream/SignalStream";
import { api, ApiError } from "@/lib/data/client";
import { count, hhmm, krw, shortId, ymd } from "@/lib/data/format";
import { useApi } from "@/lib/data/useApi";
import { asRunStatus, asStageStatus, RUN_STATUS_AS_STAGE, stageLabel, stageRank } from "@/lib/data/types";

/**
 * 실행 이력 — `/api/runs` · `/api/runs/:id`.
 *
 * ❗ **네이버 쿼터 바를 두지 않는다.** `cost_ledger` 는 일 단위 원장이라 "이 실행이 쿼터를
 *    얼마 썼는지" 는 서버가 알려 줄 수 없다. fixture 시절엔 실행마다 바가 있었지만 그건
 *    근거 없는 숫자였다 — 대신 실제로 있는 값(비용·attempt)을 보여 준다.
 *
 * ❗ 실패 잡 목록은 **admin 만** 볼 수 있다 (`jobs` RLS). 권한이 없을 때 빈 목록을 그리면
 *    "실패가 없다" 로 읽히므로, meta 의 `failedJobsVisible` 로 사유를 남긴다.
 */
export default function RunsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromStage, setFromStage] = useState("collect");

  const list = useApi(useCallback(() => api.runs(50), []), []);
  const runs = list.data ?? [];

  // 선택이 없으면 최신 실행. 목록이 갱신돼 사라진 id 를 붙들고 있지 않는다.
  const activeId = useMemo(() => {
    if (selectedId && runs.some((r) => r.id === selectedId)) return selectedId;
    return runs[0]?.id ?? null;
  }, [selectedId, runs]);

  const detail = useApi(
    useCallback(() => (activeId ? api.runDetail(activeId) : Promise.resolve({ data: null })), [activeId]),
    [activeId],
  );

  const stages = detail.data?.stages ?? [];
  const failedJobs = detail.data?.failedJobs ?? [];
  const costs = detail.data?.costs ?? [];
  const failedJobsVisible = detail.meta?.["failedJobsVisible"] !== false;

  /** 최신 attempt 만 보여 준다 — 재시도 이력을 한 스트림에 섞으면 무엇이 지금 상태인지 읽을 수 없다. */
  const latestAttempt = stages.length > 0 ? Math.max(...stages.map((s) => s.attempt_no)) : null;
  const currentStages = useMemo(
    () =>
      stages
        .filter((s) => s.attempt_no === latestAttempt)
        // ❗ API 는 알파벳 순으로 준다. DAG 순서로 다시 세운다 — 아니면 실행 순서를 오독한다.
        .sort((a, b) => stageRank(a.stage) - stageRank(b.stage)),
    [stages, latestAttempt],
  );

  const events: StreamEvent[] = currentStages.map((stage, i) => ({
    time: hhmm(stage.finished_at ?? stage.started_at),
    title: stageLabel(stage.stage),
    meta: `${stage.stage} · ${stage.done}/${stage.total}${stage.failed > 0 ? ` · 실패 ${stage.failed}` : ""}`,
    aside: <StageTag status={asStageStatus(stage.status)} />,
    tone:
      stage.status === "failed"
        ? "violet"
        : i === currentStages.length - 1 && stage.status === "succeeded"
          ? "mint"
          : "default",
  }));

  const act = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await run();
      // ❗ 낙관적 갱신을 하지 않는다. RPC 가 규칙을 강제하므로 결과를 다시 읽는다.
      list.reload();
      detail.reload();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setNotice({
        code: apiErr?.code ?? "unknown",
        message: apiErr?.message ?? `${label} 중 오류가 발생했습니다.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const activeRun = runs.find((r) => r.id === activeId);
  const cancellable =
    activeRun !== undefined && ["queued", "running", "paused"].includes(activeRun.status);
  /** 실패한 스테이지 중 파이프라인상 가장 앞선 것 — "실패만 재실행" 의 자연스러운 시작점. */
  const firstFailedStage = currentStages.find((s) => s.status === "failed" || s.failed > 0)?.stage;
  const th = "px-3 py-2 text-left k-label whitespace-nowrap";

  return (
    <>
      <ContextHeader
        kicker="System"
        title="실행 이력"
        right={
          <>
            <HeaderStat label="Runs" value={count(runs.length)} />
            <HeaderStat label="Cost" value={krw(activeRun?.cost_krw)} />
            <HeaderStat label="Attempt" value={latestAttempt === null ? "—" : `#${latestAttempt}`} />
          </>
        }
      />
      <main className="flex flex-1 flex-col gap-5 p-8">
        {notice && (
          <Notice kind="error" code={notice.code} message={notice.message} onDismiss={() => setNotice(null)} />
        )}
        {list.error ? (
          <ErrorState message={`${list.error.code} — ${list.error.message}`} />
        ) : list.loading ? (
          <LoadingState label="Runs" />
        ) : runs.length === 0 ? (
          <Notice
            kind="info"
            code="no runs"
            message="아직 실행이 없습니다. 워커가 한 번도 돌지 않았거나 보존 기간이 지나 정리되었습니다."
          />
        ) : (
          <div className="grid flex-1 grid-cols-[300px_1fr] gap-6">
            {/* 실행 목록 */}
            <div className="flex flex-col gap-2">
              {runs.map((r) => {
                const active = r.id === activeId;
                return (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    aria-pressed={active}
                    title={r.id}
                    className={`flex cursor-pointer flex-col gap-2 rounded-block border px-4 py-3 text-left transition-colors duration-150 ${
                      active ? "border-mint bg-subtle" : "border-line hover:bg-subtle"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-fg">
                        {shortId(r.id)}
                      </span>
                      <StageTag status={RUN_STATUS_AS_STAGE[asRunStatus(r.status)]} />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-fg-2">
                      <span className="font-mono tabular-nums">
                        {ymd(r.run_date)} {hhmm(r.started_at)} → {r.finished_at ? hhmm(r.finished_at) : "…"}
                      </span>
                      <span className="font-mono tabular-nums">{krw(r.cost_krw)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-fg-2">
                      <span className="mono-label text-[9px]">{r.trigger}</span>
                      <span className="font-mono tabular-nums">attempt {count(r.attempts)}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 스테이지 스트림 + 비용 + 실패 잡 */}
            <div className="flex min-w-0 flex-col gap-6">
              <section className="rounded-card border border-line p-6">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
                  <MonoLabel accent>Pipeline Stages</MonoLabel>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="재실행 시작 스테이지"
                      value={fromStage}
                      onChange={(e) => setFromStage(e.target.value)}
                      className="h-7 rounded-tag border border-line bg-canvas px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3 focus:border-mint focus:outline-none"
                    >
                      {currentStages.map((s) => (
                        <option key={s.stage} value={s.stage}>
                          {s.stage}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      disabled={busy || !activeId || firstFailedStage === undefined}
                      onClick={() =>
                        void act("실패 스테이지 재실행", () => api.retryRun(activeId!, firstFailedStage!))
                      }
                    >
                      실패부터 재실행
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !activeId}
                      onClick={() => void act("스테이지 재실행", () => api.retryRun(activeId!, fromStage))}
                    >
                      선택 스테이지부터
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !cancellable}
                      onClick={() => void act("실행 취소", () => api.cancelRun(activeId!, "운영자 취소"))}
                    >
                      취소
                    </Button>
                  </div>
                </div>
                {detail.error ? (
                  <ErrorState message={`${detail.error.code} — ${detail.error.message}`} />
                ) : detail.loading ? (
                  <LoadingState label="Stages" />
                ) : events.length === 0 ? (
                  <p className="k-label py-6">스테이지 기록이 없습니다.</p>
                ) : (
                  <SignalStream events={events} dense />
                )}
              </section>

              {costs.length > 0 && (
                <section className="overflow-x-auto rounded-card border border-line">
                  <div className="border-b border-line px-4 py-3">
                    <MonoLabel>Cost by Provider</MonoLabel>
                  </div>
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-row bg-subtle">
                        <th className={`${th} pl-4`}>Provider</th>
                        <th className={th}>Unit</th>
                        <th className={`${th} text-right`}>수량</th>
                        <th className={`${th} pr-4 text-right`}>비용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {costs.map((c) => (
                        <tr key={`${c.provider}:${c.unit}`} className="border-b border-row last:border-b-0">
                          <td className="px-3 py-2 pl-4 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                            {c.provider}
                          </td>
                          <td className="px-3 py-2 text-fg-2">{c.unit}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-3">{count(c.qty)}</td>
                          <td className="px-3 py-2 pr-4 text-right font-mono tabular-nums text-fg-3">{krw(c.krw)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              {!failedJobsVisible ? (
                <Notice
                  kind="info"
                  code="jobs hidden"
                  message="실패한 잡 목록은 admin 만 볼 수 있습니다 (jobs 테이블 RLS). 실패가 없다는 뜻이 아닙니다."
                />
              ) : (
                failedJobs.length > 0 && (
                  <section className="overflow-x-auto rounded-card border border-line">
                    <div className="border-b border-line px-4 py-3">
                      <MonoLabel>Failed Jobs · {failedJobs.length}</MonoLabel>
                    </div>
                    <table className="w-full border-collapse text-[12px]">
                      <thead>
                        <tr className="border-b border-row bg-subtle">
                          <th className={`${th} pl-4`}>Job</th>
                          <th className={th}>Stage</th>
                          <th className={th}>상태</th>
                          <th className={th}>에러</th>
                          <th className={`${th} pr-4 text-right`}>시도</th>
                        </tr>
                      </thead>
                      <tbody>
                        {failedJobs.map((job) => (
                          <tr key={job.id} className="border-b border-row last:border-b-0">
                            <td className="px-3 py-2 pl-4 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                              {job.id}
                            </td>
                            <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-2">
                              {job.stage}
                            </td>
                            <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-2">
                              {job.status}
                            </td>
                            {/* 잡은 스테이지 단위다 — 업체명은 없다. 없는 열을 만들지 않는다. */}
                            <td className="px-3 py-2 text-fg-2">{job.last_error ?? "—"}</td>
                            <td className="px-3 py-2 pr-4 text-right font-mono text-[11px] tabular-nums text-fg-2">
                              {job.attempts}/{job.max_attempts}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                )
              )}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
