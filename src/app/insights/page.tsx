import { ContextHeader } from "@/components/shell/ContextHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export default function InsightsPage() {
  return (
    <>
      <ContextHeader kicker="Engage" title="Insights" />
      <main className="flex-1 p-8">
        <EmptyState
          ghost="Sight"
          title="성과 분석"
          description="업종·취약점 유형별 승인율, 회신율, 수주 전환율을 분석하는 모듈입니다. 점수 룰 버전(rule_version)별 성과 비교로 3축 가중치 조정 근거를 제공합니다."
          planned
        />
      </main>
    </>
  );
}
