import type { OrsChannelResult } from "@/lib/data/types";

const CHANNEL_LABEL: Record<OrsChannelResult["channel"], string> = {
  blog: "BLOG",
  cafe: "CAFE",
  web: "WEB",
  news: "NEWS",
};

/**
 * 검색 점유 공백 패널 — 채널별 콘텐츠 회수량을 경쟁 중앙값과 비교한다.
 *
 * ❗ 카피 규정 (설계서 결론 C): "검색 노출·순위·점유율" 표현 금지.
 *    "네이버 Open API 기준 콘텐츠 회수량"으로만 표기한다.
 */
export function SearchGapPanel({
  channels,
  placeRegistered,
  orsScored,
}: {
  channels: OrsChannelResult[];
  placeRegistered: boolean;
  orsScored: boolean;
}) {
  const max = Math.max(...channels.map((c) => Math.max(c.count, c.competitorMedian)), 1);

  return (
    <div className="flex flex-col gap-3">
      {/* 범례 */}
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5 text-[10px] text-fg-2">
          <span aria-hidden className="h-1.5 w-3 rounded-[1px] bg-fg-3" /> 당사 회수량
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-fg-2">
          <span aria-hidden className="h-1.5 w-3 rounded-[1px] bg-violet-bright" /> 경쟁 중앙값
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {channels.map((ch) => {
          const gap = ch.competitorMedian > 0 ? Math.round((ch.count / ch.competitorMedian) * 100) : 100;
          return (
            <div key={ch.channel} className="flex items-center gap-3">
              <span className="mono-label w-[44px] shrink-0 text-[9px]">{CHANNEL_LABEL[ch.channel]}</span>
              <div className="flex flex-1 flex-col gap-[3px]">
                <div className="h-[5px] overflow-hidden rounded-[1px] bg-surface">
                  <div className="h-full bg-fg-3" style={{ width: `${(ch.count / max) * 100}%` }} />
                </div>
                <div className="h-[5px] overflow-hidden rounded-[1px] bg-surface">
                  <div
                    className="h-full bg-violet-bright"
                    style={{ width: `${(ch.competitorMedian / max) * 100}%` }}
                  />
                </div>
              </div>
              <span className="w-[86px] shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-3">
                {ch.count}
                <span className="text-fg-2"> vs {ch.competitorMedian}</span>
              </span>
              <span
                className={`w-[42px] shrink-0 text-right font-mono text-[11px] font-semibold tabular-nums ${
                  gap < 30 ? "text-violet-bright" : "text-fg-2"
                }`}
              >
                {gap}%
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t border-row pt-2.5">
        <span className="text-xs text-fg-2">플레이스 등록</span>
        <span className={`mono-label text-[9px] ${placeRegistered ? "text-mint" : "text-violet-bright"}`}>
          {placeRegistered ? "Registered" : "Not Registered"}
        </span>
      </div>

      <p className="text-[10px] leading-relaxed text-fg-2">
        네이버 Open API 기준 콘텐츠 회수량 (ORS) · local 채널은 집계 제외
        {orsScored ? " · 배점 반영" : " · 배점 미반영 (shadow — 검증 전)"}
      </p>
    </div>
  );
}
