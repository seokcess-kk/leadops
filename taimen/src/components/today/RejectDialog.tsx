"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { REJECT_REASONS } from "@/lib/data/types";

/**
 * 제외 사유 선택 다이얼로그.
 * 제외는 사유가 필수 — 사유에 따라 cooldown 이 설정되고 재평가 풀로 복귀한다 (§8.3).
 * 키보드: 1~4 사유 선택, Enter 확정, Esc 취소.
 */
export function RejectDialog({
  targetLabel,
  onConfirm,
  onClose,
}: {
  targetLabel: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<string>(REJECT_REASONS[0]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") onConfirm(reason);
      else if (["1", "2", "3", "4"].includes(e.key)) {
        setReason(REJECT_REASONS[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reason, onConfirm, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div aria-hidden onClick={onClose} className="absolute inset-0 bg-black/33" />
      <div
        role="dialog"
        aria-label="제외 사유 선택"
        className="relative w-[380px] rounded-card border border-line bg-canvas p-6"
      >
        <div className="flex flex-col gap-1 pb-4">
          <MonoLabel accent>Exclude</MonoLabel>
          <h3 className="text-[15px] font-semibold text-fg">{targetLabel}</h3>
        </div>
        <div className="flex flex-col" role="radiogroup" aria-label="제외 사유">
          {REJECT_REASONS.map((r, i) => (
            <label
              key={r}
              className={`flex cursor-pointer items-center gap-3 border-b border-row py-2.5 text-[13px] last:border-b-0 ${
                reason === r ? "text-fg" : "text-fg-2"
              }`}
            >
              <input
                type="radio"
                name="reject-reason"
                value={r}
                checked={reason === r}
                onChange={() => setReason(r)}
                className="h-3.5 w-3.5 cursor-pointer appearance-none rounded-full border border-line-strong checked:border-mint checked:bg-mint"
                autoFocus={i === 0}
              />
              <span className="flex-1">{r}</span>
              <span className="font-mono text-[10px] text-fg-2">{i + 1}</span>
            </label>
          ))}
        </div>
        <p className="pt-3 text-[10px] leading-relaxed text-fg-2">
          제외 업체는 cooldown 후 재평가 풀로 복귀합니다.
        </p>
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="ghost" size="sm" onClick={onClose}>취소</Button>
          <Button size="sm" onClick={() => onConfirm(reason)}>제외 확정</Button>
        </div>
      </div>
    </div>
  );
}
