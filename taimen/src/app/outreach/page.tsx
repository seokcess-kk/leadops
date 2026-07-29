import { ContextHeader } from "@/components/shell/ContextHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export default function OutreachPage() {
  return (
    <>
      <ContextHeader kicker="Engage" title="Outreach" />
      <main className="flex-1 p-8">
        <EmptyState
          ghost="Reach"
          title="이메일 발송 · 회신 추적"
          description="승인 리드에게 시퀀스 이메일을 발송하고 오픈·회신을 추적하는 모듈입니다. 발송·회신 이벤트는 SignalStream 타임라인으로 기록되며, 리드 상태를 SENT → OPENED → REPLIED 로 전이시킵니다."
          planned
        />
      </main>
    </>
  );
}
