import type { ReactNode } from "react";

export interface StreamEvent {
  /** 모노 타임스탬프 (시각·날짜·스테이지 번호 등) */
  time: string;
  title: string;
  meta?: string;
  /** 우측 부가 콘텐츠 (태그·카운트) */
  aside?: ReactNode;
  /** mint = 성공·주요 이벤트, violet = 실패·경고. 기본은 절제 블록 */
  tone?: "default" | "mint" | "violet";
}

/**
 * SignalStream — The Verge StoryStream 의 재해석.
 * 좌측 세로 레일(1px 보라) + 모노 타임스탬프 + 둥근 이벤트 블록.
 * 중요한 이벤트만 민트·보라 단색 블록으로 리듬을 깬다. 그림자 없음.
 */
export function SignalStream({ events, dense = false }: { events: StreamEvent[]; dense?: boolean }) {
  return (
    <ol className="relative flex flex-col gap-2.5 pl-[76px]">
      {/* 세로 레일 */}
      <span
        aria-hidden
        className="absolute bottom-2 left-[62px] top-2 w-px bg-violet-rule"
      />
      {events.map((event, i) => {
        const tone = event.tone ?? "default";
        const block =
          tone === "mint"
            ? "bg-mint text-ink"
            : tone === "violet"
              ? "bg-violet text-fg"
              : "border border-line bg-subtle";
        return (
          <li key={i} className="relative">
            {/* 타임스탬프 — 레일 왼쪽 */}
            <span className="mono-label absolute -left-[76px] top-1/2 w-[56px] -translate-y-1/2 text-right text-[9px] leading-tight">
              {event.time}
            </span>
            {/* 레일 위 상태점 */}
            <span
              aria-hidden
              className={`absolute -left-[15.5px] top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full ${
                tone === "mint" ? "bg-mint" : tone === "violet" ? "bg-violet-bright" : "bg-surface"
              }`}
            />
            <div
              className={`flex items-center justify-between gap-3 rounded-block ${block} ${
                dense ? "px-3.5 py-2" : "px-4 py-2.5"
              }`}
            >
              <div className="flex min-w-0 flex-col">
                <span className={`truncate text-[13px] font-medium ${tone === "mint" ? "text-ink" : "text-fg"}`}>
                  {event.title}
                </span>
                {event.meta && (
                  <span
                    className={`truncate text-[11px] ${
                      tone === "mint" ? "text-ink/60" : tone === "violet" ? "text-fg-3" : "text-fg-2"
                    }`}
                  >
                    {event.meta}
                  </span>
                )}
              </div>
              {event.aside && <div className="shrink-0">{event.aside}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
