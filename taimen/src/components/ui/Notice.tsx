"use client";

/**
 * 서버가 거절한 이유를 그대로 보여 준다.
 *
 * ❗ 승인은 일 상한(409)·업종 쿼터(409)·MX 미통과(422)·nonce 만료(403)로 거절될 수 있다.
 *    이걸 삼키면 검수자는 버튼이 왜 안 먹는지 알 수 없다. 코드도 함께 보여 준다 —
 *    문구는 바뀌어도 코드는 남으므로 문의·재현에 쓸 수 있다.
 *
 * 디자인 규정: 카드·그라데이션·애니메이션 없음. 1px 테두리와 단색만.
 */
export function Notice({
  kind,
  code,
  message,
  onDismiss,
  action,
}: {
  kind: "error" | "info";
  code: string;
  message: string;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
}) {
  const accent = kind === "error" ? "border-l-violet-bright" : "border-l-mint";

  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`flex items-start justify-between gap-4 rounded-block border border-line ${accent} border-l-2 bg-subtle px-4 py-3`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="mono-label text-[9px]">{code}</span>
        <p className="text-[13px] leading-relaxed text-fg-3">{message}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {action && (
          <button onClick={action.onClick} className="link-hover text-xs text-fg-3 underline-offset-2">
            {action.label}
          </button>
        )}
        {onDismiss && (
          <button onClick={onDismiss} aria-label="닫기" className="link-hover text-sm leading-none text-fg-2">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
