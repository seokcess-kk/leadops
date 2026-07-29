import { ContextHeader } from "@/components/shell/ContextHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export default function PipelinePage() {
  return (
    <>
      <ContextHeader kicker="Engage" title="Pipeline" />
      <main className="flex-1 p-8">
        <EmptyState
          ghost="Pipe"
          title="영업 파이프라인"
          description="회신 리드를 미팅 → 제안 → 수주로 관리하는 모듈입니다. 단계 변경 이력은 SignalStream 으로 남고, 리드 상태를 MEETING → PROPOSAL → WON / LOST 로 전이시킵니다."
          planned
        />
      </main>
    </>
  );
}
