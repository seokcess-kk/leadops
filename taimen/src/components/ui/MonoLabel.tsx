import type { ReactNode } from "react";

/**
 * 모노 대문자 섹션 라벨. 드로어 섹션·패널 헤더에 사용.
 * index 를 주면 "01 · COMPANY" 형태의 시그니처 넘버링이 붙는다.
 */
export function MonoLabel({
  index,
  children,
  accent = false,
}: {
  index?: number;
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <span className={`mono-label ${accent ? "text-mint" : ""}`}>
      {index !== undefined && (
        <span className="text-fg-2">{String(index).padStart(2, "0")} · </span>
      )}
      {children}
    </span>
  );
}
