"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EMAIL_TYPE_LABEL, type EmailType, type EnteredEmail, type ReviewItem } from "@/lib/data/types";

const EMAIL_TYPES: EmailType[] = [
  "representative",
  "inquiry",
  "partnership",
  "marketing",
  "business_info",
  "staff",
  "unknown",
];

type StepState = "idle" | "running" | "ok" | "fail";

export interface VerifyInput {
  address: string;
  emailType: EmailType;
  contactPageId: string;
}

/**
 * 연락처 이메일 수동 입력.
 *
 * ❗ 시스템은 홈페이지에서 이메일을 자동 수집하지 않는다 (정보통신망법 제50조의2 ·
 *    설계서 결론 A). 검수자가 연락처 페이지에서 직접 확인해 입력한다.
 *
 * ❗ 문법 → DNS → MX 는 **서버가 실제로 검증한다.** 화면은 그 결과를 보여줄 뿐이고
 *    스스로 판정하지 않는다. 여기서 통과시킨 척하면 승인 게이트가 무의미해진다
 *    (서버는 `mx_ok` 를 사용자 권한으로 쓸 수 없게 막아 두었다).
 */
export function EmailEntry({
  item,
  focusSignal,
  busy,
  onVerify,
}: {
  item: ReviewItem;
  focusSignal: number;
  busy: boolean;
  onVerify: (input: VerifyInput) => Promise<EnteredEmail | undefined>;
}) {
  const [address, setAddress] = useState(item.email?.address ?? "");
  const [type, setType] = useState<EmailType>(item.email?.type ?? "inquiry");
  const [pageId, setPageId] = useState(item.contactPages[0]?.id ?? "");
  const [result, setResult] = useState<EnteredEmail | undefined>(item.email);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // e 키 → 이메일 입력 필드 포커스
  useEffect(() => {
    if (focusSignal > 0) {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({ block: "center" });
    }
  }, [focusSignal]);

  // 항목이 바뀌면 폼 상태를 다시 맞춘다.
  useEffect(() => {
    setAddress(item.email?.address ?? "");
    setType(item.email?.type ?? "inquiry");
    setPageId(item.contactPages[0]?.id ?? "");
    setResult(item.email);
    setRunning(false);
  }, [item.id, item.email, item.contactPages]);

  const steps = useMemo<[StepState, StepState, StepState]>(() => {
    if (running) return ["running", "running", "running"];
    if (!result) return ["idle", "idle", "idle"];
    switch (result.verification) {
      case "mx_ok":
        return ["ok", "ok", "ok"];
      case "dns_ok":
        return ["ok", "ok", "fail"];
      case "syntax_ok":
        return ["ok", "fail", "idle"];
      default:
        return ["fail", "idle", "idle"];
    }
  }, [result, running]);

  const verify = async (): Promise<void> => {
    if (!address.trim() || !pageId) return;
    setRunning(true);
    try {
      setResult(await onVerify({ address: address.trim(), emailType: type, contactPageId: pageId }));
    } finally {
      setRunning(false);
    }
  };

  const stepCls = (s: StepState): string =>
    s === "ok" ? "text-mint" : s === "fail" ? "text-violet-bright" : s === "running" ? "text-fg" : "text-fg-2";

  const inputCls =
    "h-8 rounded-tag border border-line bg-canvas px-3 text-[13px] text-fg placeholder:text-fg-2 focus:border-mint focus:outline-none transition-colors duration-150 disabled:opacity-50";

  const noPages = item.contactPages.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* 연락처 페이지 후보 */}
      <ul className="flex flex-col">
        {item.contactPages.map((page) => (
          <li
            key={page.id}
            className="flex items-center justify-between border-b border-row py-2 text-xs last:border-b-0"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-fg-3">{page.path}</span>
              <span className="truncate text-fg-2">{page.label}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <span className="k-label">
                신뢰 <span className="font-mono">{page.confidence === null ? "—" : page.confidence.toFixed(2)}</span>
              </span>
              <a
                href={page.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${page.path} 새 탭에서 열기`}
                className="link-hover text-fg-3"
              >
                ↗
              </a>
            </span>
          </li>
        ))}
        {noPages && (
          <li className="py-2 text-xs text-fg-2">
            연락처 페이지 후보 없음 — 이메일을 입력할 근거 페이지가 없어 승인할 수 없습니다.
          </li>
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
            disabled={noPages || busy}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void verify();
            }}
          />
          <select
            aria-label="이메일 유형"
            className={`${inputCls} appearance-none pr-7`}
            value={type}
            disabled={noPages || busy}
            onChange={(e) => setType(e.target.value as EmailType)}
          >
            {EMAIL_TYPES.map((t) => (
              <option key={t} value={t}>
                {EMAIL_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="확인한 페이지"
            className={`${inputCls} flex-1 appearance-none pr-7`}
            value={pageId}
            disabled={noPages || busy}
            onChange={(e) => setPageId(e.target.value)}
          >
            {item.contactPages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.path}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void verify()}
            disabled={noPages || busy || running || !address.trim()}
          >
            {running ? "검증 중…" : "검증 후 저장"}
          </Button>
        </div>
      </div>

      {/* 검증 단계 — 서버가 판정한 결과 */}
      <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] font-semibold uppercase tracking-[0.15em]">
        <span className={stepCls(steps[0])}>Syntax</span>
        <span aria-hidden className="text-fg-2">→</span>
        <span className={stepCls(steps[1])}>DNS</span>
        <span aria-hidden className="text-fg-2">→</span>
        <span className={stepCls(steps[2])}>MX</span>
        {result?.mxHosts && result.mxHosts.length > 0 && (
          <span className="font-sans text-[11px] font-normal normal-case tracking-normal text-fg-2">
            {result.mxHosts.slice(0, 2).join(", ")}
            {result.mxHosts.length > 2 ? ` +${result.mxHosts.length - 2}` : ""}
          </span>
        )}
        {result?.implicitMx && (
          <span className="font-sans text-[11px] font-normal normal-case tracking-normal text-fg-2">
            MX 레코드 없음 — A/AAAA 로 통과 (신뢰도 낮음)
          </span>
        )}
        {result?.reason && (
          <span className="font-sans text-[11px] font-normal normal-case tracking-normal text-violet-bright">
            {result.reason}
          </span>
        )}
      </div>

      {/* 법적 고지 — 상시 노출 */}
      <div className="flex flex-col gap-1 border-l border-line-strong pl-3 text-[10px] leading-relaxed text-fg-2">
        <p>ⓘ 시스템은 홈페이지에서 이메일을 자동 수집하지 않습니다. (정보통신망법 제50조의2)</p>
        <p>ⓘ 개인 이메일·대표자 개인 주소는 입력하지 마세요.</p>
        <p>ⓘ 문법·DNS·MX 는 서버가 검증합니다. MX 를 통과해야 승인할 수 있습니다.</p>
      </div>
    </div>
  );
}
