"use client";

import { useState } from "react";
import { ContextHeader, HeaderStat } from "@/components/shell/ContextHeader";
import { Button } from "@/components/ui/Button";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { StageTag } from "@/components/ui/StatusTag";
import { SignalStream, type StreamEvent } from "@/components/stream/SignalStream";
import { runs } from "@/lib/data/fixtures";
import type { Run, StageStatus } from "@/lib/data/types";

const RUN_STATUS_AS_STAGE: Record<Run["status"], StageStatus> = {
  queued: "pending",
  running: "running",
  succeeded: "succeeded",
  partial: "partial",
  failed: "failed",
  cancelled: "skipped",
};

/**
 * 실행 이력.
 * 일일 수집 실행의 13개 스테이지를 SignalStream 으로 표현한다 —
 * 실패 스테이지만 보라 블록, 최종 확정만 민트 블록으로 강조.
 */
export default function RunsPage() {
  const [selectedId, setSelectedId] = useState(runs[0].id);
  const run = runs.find((r) => r.id === selectedId) ?? runs[0];

  const events: StreamEvent[] = run.stages.map((stage, i) => ({
    time: stage.finishedAt ?? "—",
    title: stage.label,
    meta: `${stage.name} · ${stage.done}/${stage.total}${stage.failed > 0 ? ` · 실패 ${stage.failed}` : ""}`,
    aside: <StageTag status={stage.status} />,
    tone:
      stage.status === "failed"
        ? "violet"
        : i === run.stages.length - 1 && stage.status === "succeeded"
          ? "mint"
          : "default",
  }));

  const th = "px-3 py-2 text-left k-label whitespace-nowrap";

  return (
    <>
      <ContextHeader
        kicker="System"
        title="실행 이력"
        right={
          <>
            <HeaderStat label="Runs" value={String(runs.length)} />
            <HeaderStat
              label="Quota"
              value={`${run.naverQuotaUsed.toLocaleString("ko-KR")}/${run.naverQuotaLimit.toLocaleString("ko-KR")}`}
            />
          </>
        }
      />
      <main className="grid flex-1 grid-cols-[300px_1fr] gap-6 p-8">
        {/* 실행 목록 */}
        <div className="flex flex-col gap-2">
          {runs.map((r) => {
            const active = r.id === selectedId;
            return (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                aria-pressed={active}
                className={`flex cursor-pointer flex-col gap-2 rounded-block border px-4 py-3 text-left transition-colors duration-150 ${
                  active ? "border-mint bg-subtle" : "border-line hover:bg-subtle"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-fg">
                    {r.id}
                  </span>
                  <StageTag status={RUN_STATUS_AS_STAGE[r.status]} />
                </div>
                <div className="flex items-center justify-between text-[11px] text-fg-2">
                  <span className="font-mono tabular-nums">{r.startedAt} → {r.finishedAt ?? "…"}</span>
                  <span className="font-mono tabular-nums">₩{r.costKrw.toLocaleString("ko-KR")}</span>
                </div>
                {/* 쿼터 사용 바 */}
                <div className="h-[3px] overflow-hidden rounded-[1px] bg-surface">
                  <div
                    className="h-full bg-fg-3"
                    style={{ width: `${(r.naverQuotaUsed / r.naverQuotaLimit) * 100}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>

        {/* 스테이지 스트림 + 실패 잡 */}
        <div className="flex min-w-0 flex-col gap-6">
          <section className="rounded-card border border-line p-6">
            <div className="flex items-center justify-between pb-4">
              <MonoLabel accent>Pipeline Stages</MonoLabel>
              <div className="flex gap-2">
                <Button size="sm" disabled={run.failedJobs.length === 0}>실패만 재실행</Button>
                <Button size="sm" variant="ghost">스테이지부터 재실행</Button>
              </div>
            </div>
            <SignalStream events={events} dense />
          </section>

          {run.failedJobs.length > 0 && (
            <section className="overflow-x-auto rounded-card border border-line">
              <div className="border-b border-line px-4 py-3">
                <MonoLabel>Failed Jobs · {run.failedJobs.length}</MonoLabel>
              </div>
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-row bg-subtle">
                    <th className={`${th} pl-4`}>Job</th>
                    <th className={th}>Stage</th>
                    <th className={th}>업체</th>
                    <th className={th}>에러</th>
                    <th className={`${th} pr-4 text-right`}>시도</th>
                  </tr>
                </thead>
                <tbody>
                  {run.failedJobs.map((job) => (
                    <tr key={job.id} className="border-b border-row last:border-b-0">
                      <td className="px-3 py-2 pl-4 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                        {job.id}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-2">
                        {job.stage}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-fg-3">{job.company}</td>
                      <td className="px-3 py-2 text-fg-2">{job.error}</td>
                      <td className="px-3 py-2 pr-4 text-right font-mono text-[11px] tabular-nums text-fg-2">
                        {job.attempts}/{job.maxAttempts}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </main>
    </>
  );
}
