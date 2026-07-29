"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { AxisGauge } from "@/components/ui/LeadScore";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { SignalStream, type StreamEvent } from "@/components/stream/SignalStream";
import { AXIS_MAX, INDUSTRY_LABEL, type EnteredEmail, type ReviewItem } from "@/lib/data/types";
import { CompetitorComparison } from "./CompetitorComparison";
import { EmailEntry } from "./EmailEntry";
import { SearchGapPanel } from "./SearchGapPanel";

const OFFICIAL_LABEL: Record<ReviewItem["homepageStatus"], string> = {
  confirmed: "Confirmed",
  likely: "Likely",
  uncertain: "Uncertain",
  not_official: "Not Official",
  unavailable: "Unavailable",
};

function Section({
  index,
  label,
  sub,
  children,
}: {
  index: number;
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-line px-6 py-5 first:border-t-0">
      <div className="flex items-baseline justify-between">
        <MonoLabel index={index}>{label}</MonoLabel>
        {sub && <span className="text-[11px] text-fg-2">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * 리드 상세 드로어 (480px).
 * 작은 카드 중첩 없이 모노 섹션 라벨 + 1px 구분선 + 핵심 수치로 10개 섹션을 쌓는다.
 * 정보 순서는 요구 스펙 고정: 기본정보 → 점수 → 취약점 → 검색 공백 → 경쟁사
 * → 활동 → 검색 결과물 → 이메일 → 추천 → 승인·제외.
 */
export function DetailDrawer({
  item,
  focusEmail,
  onClose,
  onApprove,
  onReject,
  onSubmitEmail,
}: {
  item: ReviewItem;
  focusEmail: number;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
  onSubmitEmail: (email: EnteredEmail) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mxOk = item.email?.verification === "mx_ok";

  const assetEvents: StreamEvent[] = item.searchAssets.map((assetItem) => ({
    time: assetItem.date.slice(5).replace("-", "."),
    title: assetItem.title,
    meta: assetItem.channel.toUpperCase(),
    aside: assetItem.official ? (
      <span className="mono-label text-[8px] text-mint">Official</span>
    ) : undefined,
  }));

  return (
    <>
      {/* 백드롭 — 유일하게 허용된 반투명, 블러 없음 */}
      <div
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-30 bg-black/33"
      />
      <aside
        role="dialog"
        aria-label={`${item.companyName} 상세`}
        className="fixed inset-y-0 right-0 z-40 flex w-[480px] max-w-full flex-col border-l border-line-strong bg-canvas motion-safe:animate-[drawer-in_200ms_ease]"
      >
        {/* 헤더 */}
        <div className="flex shrink-0 items-start justify-between border-b border-line px-6 py-4">
          <div className="flex flex-col gap-1">
            <span className="mono-label text-[9px]">
              Rank {String(item.rank).padStart(2, "0")} · {item.id.toUpperCase()}
            </span>
            <h2 className="text-lg font-bold text-fg">{item.companyName}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="link-hover mt-1 cursor-pointer text-lg leading-none text-fg-2"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* 01 기본정보 */}
          <Section index={1} label="Company" sub="업체 기본정보">
            <dl className="grid grid-cols-[88px_1fr] gap-y-1.5 text-[13px]">
              <dt className="text-fg-2">업종</dt>
              <dd className="text-fg-3">{INDUSTRY_LABEL[item.industry]}</dd>
              <dt className="text-fg-2">지역</dt>
              <dd className="text-fg-3">{item.regionSido} {item.regionSigungu}</dd>
              <dt className="text-fg-2">홈페이지</dt>
              <dd className="flex items-center gap-2">
                {item.homepageUrl ? (
                  <a
                    href={item.homepageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="link-hover truncate text-fg-3"
                  >
                    {item.homepageUrl.replace("https://", "")} ↗
                  </a>
                ) : (
                  <span className="text-fg-2">없음</span>
                )}
                <span className="mono-label shrink-0 text-[8px]">{OFFICIAL_LABEL[item.homepageStatus]}</span>
              </dd>
              <dt className="text-fg-2">플레이스</dt>
              <dd className={`mono-label text-[9px] ${item.placeRegistered ? "text-mint" : "text-violet-bright"}`}>
                {item.placeRegistered ? "Registered" : "Not Registered"}
              </dd>
            </dl>
          </Section>

          {/* 02 총점·근거 */}
          <Section index={2} label="Score" sub="3축 점수와 근거">
            <div className="flex items-end gap-3">
              <span className={`display-num text-[56px] ${item.score.total >= 80 ? "text-mint" : "text-fg"}`}>
                {item.score.total}
              </span>
              <span className="mb-2 font-mono text-[11px] text-fg-2">/100</span>
            </div>
            <div className="flex flex-col gap-2">
              <AxisGauge label="Problem" value={item.score.problem} max={AXIS_MAX.problem} accent />
              <AxisGauge label="Propensity" value={item.score.propensity} max={AXIS_MAX.propensity} />
              <AxisGauge label="Confidence" value={item.score.confidence} max={AXIS_MAX.confidence} />
            </div>
            <ul className="flex flex-col gap-1.5 border-l border-line-strong pl-3">
              {item.scoreRationale.map((line, i) => (
                <li key={i} className="text-xs leading-relaxed text-fg-3">{line}</li>
              ))}
            </ul>
          </Section>

          {/* 03 핵심 취약점 */}
          <Section index={3} label="Weakness" sub="핵심 취약점">
            <ul className="flex flex-col">
              {item.weaknesses.map((weakness) => (
                <li
                  key={weakness.kind}
                  className="flex items-center justify-between border-b border-row py-2 last:border-b-0"
                >
                  <span className="flex items-center gap-2 text-[13px] text-fg">
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 rounded-full ${
                        weakness.severity === "high" ? "bg-violet-bright" : "bg-fg-2"
                      }`}
                    />
                    {weakness.label}
                  </span>
                  {weakness.metric && (
                    <span className="font-mono text-[11px] tabular-nums text-fg-2">{weakness.metric}</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>

          {/* 04 검색 점유 공백 */}
          <Section index={4} label="Search Gap" sub="콘텐츠 회수 점유 (ORS)">
            <SearchGapPanel
              channels={item.ors}
              placeRegistered={item.placeRegistered}
              orsScored={item.orsScored}
            />
          </Section>

          {/* 05 경쟁사 비교 */}
          <Section index={5} label="Competitors" sub="경쟁사 3곳 비교">
            <CompetitorComparison rows={item.competitors} available={item.competitorGapAvailable} />
          </Section>

          {/* 06 최근 활동 */}
          <Section index={6} label="Activity" sub="공식 채널 발행량">
            <div className="flex items-stretch gap-6">
              <div className="flex flex-col gap-0.5">
                <span className="mono-label text-[9px]">60일</span>
                <span className={`display-num text-[28px] ${item.activity60d === 0 ? "text-violet-bright" : "text-fg"}`}>
                  {item.activity60d}
                </span>
              </div>
              <span aria-hidden className="w-px bg-line" />
              <div className="flex flex-col gap-0.5">
                <span className="mono-label text-[9px]">120일</span>
                <span className="display-num text-[28px] text-fg">{item.activity120d}</span>
              </div>
              <span aria-hidden className="w-px bg-line" />
              <div className="flex flex-col gap-0.5">
                <span className="mono-label text-[9px]">최근 발행</span>
                <span className="mt-2 font-mono text-[12px] tabular-nums text-fg-3">
                  {item.lastContentAt ?? "—"}
                </span>
              </div>
            </div>
          </Section>

          {/* 07 검색 결과물 */}
          <Section index={7} label="Search Assets" sub="수집된 검색 결과물">
            <SignalStream events={assetEvents} dense />
          </Section>

          {/* 08 이메일 출처·입력 */}
          <Section index={8} label="Email Source" sub="연락처 페이지 · 수동 입력">
            <EmailEntry item={item} focusSignal={focusEmail} onSubmit={onSubmitEmail} />
          </Section>

          {/* 09 추천 서비스 */}
          <Section index={9} label="Recommend" sub="추천 서비스">
            <div className="flex flex-col gap-2">
              <div className="border-l border-mint pl-3">
                <span className="text-sm font-semibold text-fg">{item.primaryService}</span>
                <span className="mono-label ml-2 text-[8px] text-mint">Primary</span>
              </div>
              {item.secondaryServices.map((service) => (
                <div key={service} className="pl-3 text-[13px] text-fg-2">{service}</div>
              ))}
              <p className="pt-1 text-xs leading-relaxed text-fg-2">{item.recommendRationale}</p>
            </div>
          </Section>
        </div>

        {/* 10 승인·제외 — 고정 푸터 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-4">
          <MonoLabel index={10}>Decision</MonoLabel>
          <div className="flex flex-1 justify-end gap-2">
            <Button onClick={onReject}>제외</Button>
            <Button
              variant="primary"
              disabled={!mxOk}
              onClick={onApprove}
              title={mxOk ? "승인" : "MX 검증을 통과한 이메일이 필요합니다"}
            >
              승인
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
