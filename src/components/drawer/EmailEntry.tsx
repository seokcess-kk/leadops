"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { EnteredEmail, ReviewItem } from "@/lib/data/types";

const EMAIL_TYPES: EnteredEmail["type"][] = ["대표", "마케팅", "채용", "기타"];

type StepState = "idle" | "running" | "ok" | "fail";

/**
 * 연락처 이메일 수동 입력.
 *
 * ❗ 시스템은 홈페이지에서 이메일을 자동 수집하지 않는다 (정보통신망법 제50조의2 ·
 *    설계서 결론 A). 검수자가 연락처 페이지에서 직접 확인해 입력하고,
 *    문법 → DNS → MX 검증을 통과해야 승인할 수 있다.
 *
 * fixture 모드: 문법 검사는 실제로 수행하고 DNS·MX 단계는 시뮬레이션이다.
 * API 서버가 생기면 POST /api/review/:id/contact-email 로 교체한다 (store.tsx 참고).
 */
export function EmailEntry({
  item,
  focusSignal,
  onSubmit,
}: {
  item: ReviewItem;
  focusSignal: number;
  onSubmit: (email: EnteredEmail) => void;
}) {
  const [address, setAddress] = useState(item.email?.address ?? "");
  const [type, setType] = useState<EnteredEmail["type"]>(item.email?.type ?? "대표");
  const [sourcePath, setSourcePath] = useState(item.email?.sourcePath ?? item.contactPages[0]?.path ?? "");
  const [steps, setSteps] = useState<[StepState, StepState, StepState]>(
    item.email?.verification === "mx_ok" ? ["ok", "ok", "ok"] : ["idle", "idle", "idle"],
  );
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // e 키 → 이메일 입력 필드 포커스
  useEffect(() => {
    if (focusSignal > 0) {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({ block: "center" });
    }
  }, [focusSignal]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // 항목이 바뀌면 폼 상태 리셋
  useEffect(() => {
    setAddress(item.email?.address ?? "");
    setType(item.email?.type ?? "대표");
    setSourcePath(item.email?.sourcePath ?? item.contactPages[0]?.path ?? "");
    setSteps(item.email?.verification === "mx_ok" ? ["ok", "ok", "ok"] : ["idle", "idle", "idle"]);
    setMessage(null);
  }, [item.id, item.email, item.contactPages]);

  const verify = () => {
    timers.current.forEach(clearTimeout);
    const syntaxOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
    if (!syntaxOk) {
      setSteps(["fail", "idle", "idle"]);
      setMessage("이메일 형식이 올바르지 않습니다.");
      return;
    }
    setSteps(["ok", "running", "idle"]);
    setMessage(null);
    timers.current.push(
      setTimeout(() => {
        setSteps(["ok", "ok", "running"]);
        timers.current.push(
          setTimeout(() => {
            // fixture 모드 데모: 주소에 "fail" 이 포함되면 MX 실패를 재현
            if (address.includes("fail")) {
              setSteps(["ok", "ok", "fail"]);
              setMessage("MX 레코드를 찾을 수 없습니다. 승인이 차단됩니다.");
              onSubmit({ address, type, sourcePath, verification: "failed" });
            } else {
              setSteps(["ok", "ok", "ok"]);
              setMessage(null);
              onSubmit({ address, type, sourcePath, verification: "mx_ok" });
            }
          }, 500),
        );
      }, 350),
    );
  };

  const stepCls = (s: StepState) =>
    s === "ok"
      ? "text-mint"
      : s === "fail"
        ? "text-violet-bright"
        : s === "running"
          ? "text-fg"
          : "text-fg-2";

  const inputCls =
    "h-8 rounded-tag border border-line bg-canvas px-3 text-[13px] text-fg placeholder:text-fg-2 focus:border-mint focus:outline-none transition-colors duration-150";

  return (
    <div className="flex flex-col gap-4">
      {/* 연락처 페이지 후보 */}
      <ul className="flex flex-col">
        {item.contactPages.map((page) => (
          <li
            key={page.path}
            className="flex items-center justify-between border-b border-row py-2 text-xs last:border-b-0"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-fg-3">{page.path}</span>
              <span className="truncate text-fg-2">{page.label}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <span className="k-label">
                신뢰 <span className="font-mono">{page.confidence.toFixed(2)}</span>
              </span>
              {item.homepageUrl && (
                <a
                  href={`${item.homepageUrl}${page.path}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${page.path} 새 탭에서 열기`}
                  className="link-hover text-fg-3"
                >
                  ↗
                </a>
              )}
            </span>
          </li>
        ))}
        {item.contactPages.length === 0 && (
          <li className="py-2 text-xs text-fg-2">연락처 페이지 후보 없음</li>
        )}
      </ul>

      {/* 입력 폼 */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="email"
            aria-label="업무용 이메일"
            placeholder="확인한 업무용 이메일 입력"
            className={`${inputCls} flex-1`}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && verify()}
          />
          <select
            aria-label="이메일 유형"
            className={`${inputCls} appearance-none pr-7`}
            value={type}
            onChange={(e) => setType(e.target.value as EnteredEmail["type"])}
          >
            {EMAIL_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="확인한 페이지"
            className={`${inputCls} flex-1 appearance-none pr-7`}
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
          >
            {item.contactPages.map((page) => (
              <option key={page.path} value={page.path}>{page.path}</option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={verify} disabled={!address}>
            검증 후 저장
          </Button>
        </div>
      </div>

      {/* 검증 단계 */}
      <div className="flex items-center gap-3 font-mono text-[10px] font-semibold uppercase tracking-[0.15em]">
        <span className={stepCls(steps[0])}>Syntax</span>
        <span aria-hidden className="text-fg-2">→</span>
        <span className={stepCls(steps[1])}>DNS</span>
        <span aria-hidden className="text-fg-2">→</span>
        <span className={stepCls(steps[2])}>MX</span>
        {message && <span className="ml-1 font-sans text-[11px] font-normal normal-case tracking-normal text-violet-bright">{message}</span>}
      </div>

      {/* 법적 고지 — 상시 노출 */}
      <div className="flex flex-col gap-1 border-l border-line-strong pl-3 text-[10px] leading-relaxed text-fg-2">
        <p>ⓘ 시스템은 홈페이지에서 이메일을 자동 수집하지 않습니다. (정보통신망법 제50조의2)</p>
        <p>ⓘ 개인 이메일·대표자 개인 주소는 입력하지 마세요.</p>
      </div>
    </div>
  );
}
