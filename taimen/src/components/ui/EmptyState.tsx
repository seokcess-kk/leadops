import { MonoLabel } from "./MonoLabel";

/**
 * 빈 상태 / 향후 모듈 예약 화면.
 * 디스플레이 폰트를 고스트 컬러(#2d2d2d)로 크게 깔아 컬러 없이 브랜드 인상을 만든다.
 */
export function EmptyState({
  ghost,
  title,
  description,
  planned = false,
  children,
}: {
  ghost: string;
  title: string;
  description: string;
  planned?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-[520px] flex-col items-start justify-end overflow-hidden rounded-card border border-line p-10">
      <span
        aria-hidden
        className="display-num pointer-events-none absolute -top-6 left-6 select-none text-[clamp(96px,18vw,220px)] uppercase text-surface"
      >
        {ghost}
      </span>
      <div className="relative flex flex-col gap-3">
        {planned && (
          <span className="inline-flex w-fit items-center rounded-full border border-violet-rule px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-violet-bright">
            Planned Module
          </span>
        )}
        <h2 className="text-xl font-bold text-fg">{title}</h2>
        <p className="max-w-[480px] text-sm leading-relaxed text-fg-2">{description}</p>
        {children}
      </div>
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-[240px] items-center justify-center rounded-card border border-line">
      <MonoLabel accent>{label} …</MonoLabel>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-card border border-violet-rule p-8">
      <span className="mono-label text-violet-bright">Error</span>
      <p className="text-sm text-fg-3">{message}</p>
    </div>
  );
}
