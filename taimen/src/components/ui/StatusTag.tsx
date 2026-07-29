import type { LeadStatus, StageStatus } from "@/lib/data/types";

/**
 * 모노 pill 상태 태그. 컬러는 상태 의미가 있을 때만:
 * 민트 = 성공·진행 가치 (READY·WON·succeeded), 보라 = 이탈·실패 (LOST·failed).
 * 나머지는 무채색 테두리 — 과도한 컬러 배지를 피한다.
 */
const LEAD_STYLES: Record<LeadStatus, string> = {
  READY: "border-mint-dim text-mint",
  SENT: "border-line text-fg-3",
  OPENED: "border-line text-fg-3",
  REPLIED: "border-line-strong text-fg",
  MEETING: "border-line-strong text-fg",
  PROPOSAL: "border-line-strong text-fg",
  WON: "border-mint bg-mint text-ink",
  LOST: "border-violet-rule text-violet-bright",
};

export function StatusTag({ status }: { status: LeadStatus }) {
  return (
    <span
      className={`inline-flex h-[22px] items-center rounded-full border px-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] ${LEAD_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

const STAGE_STYLES: Record<StageStatus, { label: string; cls: string }> = {
  pending: { label: "PENDING", cls: "border-line text-fg-2" },
  running: { label: "RUNNING", cls: "border-mint-dim text-mint" },
  succeeded: { label: "OK", cls: "border-line text-fg-3" },
  partial: { label: "PARTIAL", cls: "border-line-strong text-fg" },
  failed: { label: "FAILED", cls: "border-violet-rule text-violet-bright" },
  skipped: { label: "SKIP", cls: "border-line text-fg-2" },
};

export function StageTag({ status }: { status: StageStatus }) {
  const s = STAGE_STYLES[status];
  return (
    <span
      className={`inline-flex h-[20px] items-center rounded-full border px-2 font-mono text-[9px] font-semibold uppercase tracking-[0.15em] ${s.cls}`}
    >
      {s.label}
    </span>
  );
}
