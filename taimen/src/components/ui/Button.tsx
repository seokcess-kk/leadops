import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "outline" | "ghost";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

/**
 * pill 버튼. 그림자 없음 — 위계는 채움색과 1px 테두리로만.
 * primary  민트 채움 (승인·핵심 CTA 전용)
 * secondary 슬레이트 채움 (제외·일반 액션)
 * outline  민트 1px 테두리 + 모노 대문자 (보조 CTA)
 * ghost    테두리 없는 텍스트 버튼
 */
export function Button({ variant = "secondary", size = "md", className = "", ...props }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-full font-medium cursor-pointer select-none transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-35";
  const sizes: Record<Size, string> = {
    sm: "h-7 px-3 text-xs",
    md: "h-9 px-5 text-sm",
  };
  const variants: Record<Variant, string> = {
    primary: "bg-mint text-ink hover:bg-white",
    secondary: "bg-surface text-fg-3 hover:bg-[#3a3a3a]",
    outline:
      "border border-mint-dim bg-transparent text-mint hover:bg-mint hover:text-ink font-mono uppercase tracking-[0.12em] text-[11px] font-semibold",
    ghost: "bg-transparent text-fg-2 hover:text-hoverlink",
  };
  return <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props} />;
}
