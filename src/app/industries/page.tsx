"use client";

import { useState } from "react";
import { ContextHeader, HeaderStat } from "@/components/shell/ContextHeader";
import { Button } from "@/components/ui/Button";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { industries as industryFixture } from "@/lib/data/fixtures";
import { INDUSTRY_LABEL } from "@/lib/data/types";

/**
 * 업종·키워드 설정.
 * 키워드 템플릿은 {업체명}·{지역}·{진료과목} 토큰을 지원한다.
 * LLM 초안은 approved=false 로 들어와 사람이 승인해야 사용된다 (§8.2).
 */
export default function IndustriesPage() {
  const [data, setData] = useState(industryFixture);

  const approveKeyword = (industryKey: string, keywordId: string) => {
    setData((prev) =>
      prev.map((ind) =>
        ind.industry === industryKey
          ? {
              ...ind,
              keywords: ind.keywords.map((kw) =>
                kw.id === keywordId ? { ...kw, approved: true } : kw,
              ),
            }
          : ind,
      ),
    );
  };

  const totalUniverse = data.reduce((sum, ind) => sum + ind.universeEligible, 0);

  // 템플릿의 {토큰} 만 민트로 — 컬러를 정보에만 쓴다
  const renderTemplate = (template: string) =>
    template.split(/(\{[^}]+\})/).map((part, i) =>
      part.startsWith("{") ? (
        <span key={i} className="text-mint">{part}</span>
      ) : (
        <span key={i}>{part}</span>
      ),
    );

  return (
    <>
      <ContextHeader
        kicker="System"
        title="업종 · 키워드"
        right={<HeaderStat label="Universe" value={totalUniverse.toLocaleString("ko-KR")} />}
      />
      <main className="flex flex-1 flex-col gap-6 p-8">
        <p className="max-w-[720px] text-[13px] leading-relaxed text-fg-2">
          모집단은 유한합니다 (설계서 결론 D). 아래 수치는 기본 제외(폐업·대형·가맹점 100+)
          적용 후 남은 발굴 가능 업체 수입니다. 키워드 템플릿의 LLM 초안은 승인 후에만
          수집에 사용됩니다.
        </p>

        <div className="grid grid-cols-2 gap-5">
          {data.map((ind) => (
            <section key={ind.industry} className="flex flex-col rounded-card border border-line">
              <div className="flex items-end justify-between border-b border-line px-5 py-4">
                <div className="flex flex-col gap-0.5">
                  <MonoLabel accent>{ind.industry}</MonoLabel>
                  <h2 className="text-[15px] font-semibold text-fg">{INDUSTRY_LABEL[ind.industry]}</h2>
                </div>
                <div className="flex gap-5">
                  <div className="flex flex-col items-end">
                    <span className="k-label text-[9px]">모집단</span>
                    <span className="display-num text-[24px] text-fg">
                      {ind.universeEligible.toLocaleString("ko-KR")}
                    </span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="k-label text-[9px]">오늘 후보</span>
                    <span className="display-num text-[24px] text-fg">{ind.todayCandidates}</span>
                  </div>
                </div>
              </div>
              <ul className="flex flex-col px-5 py-2">
                {ind.keywords.map((kw) => (
                  <li
                    key={kw.id}
                    className="flex items-center justify-between gap-3 border-b border-row py-2.5 last:border-b-0"
                  >
                    <span className="min-w-0 truncate text-[13px] text-fg-3">
                      {renderTemplate(kw.template)}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {kw.source === "llm" && (
                        <span className="mono-label text-[8px] text-violet-bright">LLM Draft</span>
                      )}
                      {kw.approved ? (
                        <span className="mono-label text-[8px] text-mint">Approved</span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2.5 text-[9px]"
                          onClick={() => approveKeyword(ind.industry, kw.id)}
                        >
                          승인
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>
    </>
  );
}
