"use client";

import { useCallback, useState } from "react";
import { ContextHeader, HeaderStat } from "@/components/shell/ContextHeader";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState } from "@/components/ui/EmptyState";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { Notice } from "@/components/ui/Notice";
import { api, ApiError, type ApiAccessReport, type ApiPrivacyRequest } from "@/lib/data/client";
import { count, ymd } from "@/lib/data/format";
import { useApi } from "@/lib/data/useApi";

/**
 * 개인정보 요청 처리 (열람 · 삭제 · 처리정지 · 정정).
 *
 * ❗ 기한은 접수 시점에 **10일**로 못 박혀 있다 (개인정보보호법 시행령 제41·43·44조).
 *    화면이 계산하지 않는다 — 계산을 화면에 두면 기준이 흔들린다.
 *
 * ❗ **집행은 되돌릴 수 없다.** 이메일을 파기하고 접촉을 영구 차단한다. 그래서 확인 단계를
 *    두 번 거치게 하고, 무엇을 했는지(`actions_taken`)를 그대로 보여 준다.
 *
 * ❗ 접수만 되고 처리되지 않은 상태가 가장 위험하다. 기한 초과를 목록 맨 위에 눈에 띄게 둔다.
 */

const KIND_LABEL: Record<ApiPrivacyRequest["kind"], string> = {
  access: "열람",
  delete: "삭제",
  suspend: "처리정지",
  correct: "정정",
};

const STATUS_LABEL: Record<ApiPrivacyRequest["status"], string> = {
  received: "접수",
  in_progress: "처리 중",
  on_hold: "보류",
  completed: "완료",
  rejected: "거절",
};

/** 집행 가능한 종류. 열람·정정은 사람이 처리한다 (자동 집행할 것이 없다). */
const EXECUTABLE = new Set<ApiPrivacyRequest["kind"]>(["delete", "suspend"]);
const OPEN = new Set<ApiPrivacyRequest["status"]>(["received", "in_progress", "on_hold"]);

function StatusTag({ request }: { request: ApiPrivacyRequest }) {
  const cls = request.overdue
    ? "border-violet-rule text-violet-bright"
    : request.status === "completed"
      ? "border-mint-dim text-mint"
      : OPEN.has(request.status)
        ? "border-line-strong text-fg"
        : "border-line text-fg-2";
  return (
    <span
      className={`inline-flex h-[20px] items-center rounded-full border px-2 font-mono text-[9px] font-semibold uppercase tracking-[0.15em] ${cls}`}
    >
      {STATUS_LABEL[request.status]}
      {request.overdue ? " · 기한초과" : ""}
    </span>
  );
}

function AccessReportPanel({ report }: { report: ApiAccessReport }) {
  return (
    <div className="flex flex-col gap-3 border-t border-row pt-3">
      <MonoLabel accent>열람 보고서</MonoLabel>
      <p className="text-[11px] leading-relaxed text-fg-2">{report.note}</p>

      <div className="flex flex-col gap-1">
        <MonoLabel>보유 이메일 · {report.emails.length}</MonoLabel>
        {report.emails.length === 0 ? (
          <p className="text-[12px] text-fg-2">보유한 이메일이 없습니다.</p>
        ) : (
          <ul className="flex flex-col">
            {report.emails.map((email) => (
              <li key={email.address} className="border-b border-row py-2 text-[12px] last:border-b-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-fg-3">{email.address}</span>
                  <span className="shrink-0 font-mono text-[10px] text-fg-2">
                    {email.email_type} · {email.acquisition_method}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 text-[10px] text-fg-2">
                  <span>근거: {email.collection_legal_basis}</span>
                  <span>보유기한: {email.retention_until.slice(0, 10)}</span>
                  {/* 어디서 확인했는지가 manual_entry 주장의 증거다. */}
                  {email.source_url && <span className="truncate">확인 페이지: {email.source_url}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <MonoLabel>승인 리드 · {report.leads.length}</MonoLabel>
        {report.leads.length === 0 ? (
          <p className="text-[12px] text-fg-2">승인된 리드가 없습니다.</p>
        ) : (
          <ul className="flex flex-col">
            {report.leads.map((lead) => (
              <li
                key={lead.id}
                className="flex items-baseline justify-between gap-3 border-b border-row py-1.5 text-[12px] last:border-b-0"
              >
                <span className="text-fg-3">{lead.approval_date.slice(0, 10)}</span>
                <span className="font-mono text-[10px] text-fg-2">
                  {lead.contact_legal_basis} · export {lead.export_status}({lead.export_count})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function PrivacyPage() {
  const [openOnly, setOpenOnly] = useState(true);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; code: string; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, ApiAccessReport>>({});
  /** 집행 확인 대기 중인 요청. 되돌릴 수 없으므로 두 번 누르게 한다. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [holdNote, setHoldNote] = useState<Record<string, string>>({});

  const list = useApi(useCallback(() => api.privacyRequests(openOnly), [openOnly]), [openOnly]);
  const rows = list.data ?? [];
  const overdue = rows.filter((r) => r.overdue).length;

  const act = async (id: string, label: string, run: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    setNotice(null);
    try {
      await run();
      list.reload();
      setNotice({ kind: "info", code: "done", message: `${label} 처리했습니다.` });
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setNotice({
        kind: "error",
        code: apiErr?.code ?? "unknown",
        message: apiErr?.message ?? `${label} 중 오류가 발생했습니다.`,
      });
    } finally {
      setBusyId(null);
      setConfirming(null);
    }
  };

  const showReport = async (id: string): Promise<void> => {
    setBusyId(id);
    setNotice(null);
    try {
      const result = await api.privacyAccessReport(id);
      setReports((prev) => ({ ...prev, [id]: result.data }));
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setNotice({
        kind: "error",
        code: apiErr?.code ?? "unknown",
        message: apiErr?.message ?? "열람 보고서를 만들 수 없습니다.",
      });
    } finally {
      setBusyId(null);
    }
  };

  const inputCls =
    "h-8 flex-1 rounded-tag border border-line bg-canvas px-3 text-[12px] text-fg placeholder:text-fg-2 focus:border-mint focus:outline-none";

  return (
    <>
      <ContextHeader
        kicker="System"
        title="개인정보 요청"
        right={
          <>
            <HeaderStat label="Open" value={count(rows.filter((r) => OPEN.has(r.status)).length)} />
            <HeaderStat label="Overdue" value={count(overdue)} accent={overdue > 0} />
          </>
        }
      />
      <main className="flex flex-1 flex-col gap-5 p-8">
        <p className="max-w-[760px] text-[13px] leading-relaxed text-fg-2">
          열람·정정·삭제·처리정지 요청을 <span className="font-mono text-fg-3">10일</span> 안에 처리해야
          합니다 (개인정보보호법 시행령 제41·43·44조). 기한은 접수 시점에 고정되고 화면에서 계산하지
          않습니다. <span className="text-fg-3">삭제·처리정지 집행은 되돌릴 수 없습니다</span> — 이메일을
          파기하고 접촉을 영구 차단합니다.
        </p>

        {notice && (
          <Notice
            kind={notice.kind}
            code={notice.code}
            message={notice.message}
            onDismiss={() => setNotice(null)}
          />
        )}
        {overdue > 0 && (
          <Notice
            kind="error"
            code="overdue"
            message={`기한이 지난 요청이 ${overdue}건 있습니다. 접수만 되고 처리되지 않은 상태가 가장 위험합니다.`}
          />
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={openOnly ? "outline" : "ghost"}
            onClick={() => setOpenOnly(true)}
          >
            미처리만
          </Button>
          <Button size="sm" variant={openOnly ? "ghost" : "outline"} onClick={() => setOpenOnly(false)}>
            전체
          </Button>
        </div>

        {list.error ? (
          <ErrorState message={`${list.error.code} — ${list.error.message}`} />
        ) : list.loading ? (
          <LoadingState label="Requests" />
        ) : rows.length === 0 ? (
          <Notice
            kind="info"
            code="no requests"
            message={openOnly ? "미처리 요청이 없습니다." : "접수된 요청이 없습니다."}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((request) => {
              const busy = busyId === request.id;
              const open = OPEN.has(request.status);
              return (
                <section
                  key={request.id}
                  className={`flex flex-col gap-3 rounded-card border px-5 py-4 ${
                    request.overdue ? "border-violet-rule" : "border-line"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <MonoLabel accent>{KIND_LABEL[request.kind]}</MonoLabel>
                        <StatusTag request={request} />
                        {request.legal_hold && (
                          <span className="mono-label text-[8px] text-violet-bright">Legal Hold</span>
                        )}
                      </span>
                      <span className="text-[14px] font-semibold text-fg">{request.subject_identifier}</span>
                      <span className="text-[11px] text-fg-2">
                        {request.company_name ?? "연결된 업체 없음 — 무엇을 처리할지 특정할 수 없습니다"}
                      </span>
                    </div>
                    <div className="flex flex-col items-end text-[11px] text-fg-2">
                      <span className="font-mono tabular-nums">접수 {ymd(request.received_at)}</span>
                      <span className={`font-mono tabular-nums ${request.overdue ? "text-violet-bright" : ""}`}>
                        기한 {ymd(request.due_at)}
                      </span>
                      {request.completed_at && (
                        <span className="font-mono tabular-nums">완료 {ymd(request.completed_at)}</span>
                      )}
                    </div>
                  </div>

                  {request.hold_reason && (
                    <p className="border-l border-violet-rule pl-3 text-[12px] text-fg-3">
                      사유: {request.hold_reason}
                    </p>
                  )}

                  {request.actions_taken.length > 0 && (
                    <div className="border-t border-row pt-2">
                      <MonoLabel>집행 기록</MonoLabel>
                      <pre className="mt-1 overflow-x-auto font-mono text-[10px] leading-relaxed text-fg-2">
                        {JSON.stringify(request.actions_taken, null, 2)}
                      </pre>
                    </div>
                  )}

                  {reports[request.id] && <AccessReportPanel report={reports[request.id]!} />}

                  {open && (
                    <div className="flex flex-col gap-2 border-t border-row pt-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {request.status === "received" && (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void act(request.id, "처리 시작", () =>
                                api.advancePrivacyRequest(request.id, "in_progress"),
                              )
                            }
                          >
                            처리 시작
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void showReport(request.id)}
                        >
                          열람 보고서
                        </Button>
                        {EXECUTABLE.has(request.kind) &&
                          (confirming === request.id ? (
                            <>
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busy}
                                onClick={() =>
                                  void act(request.id, `${KIND_LABEL[request.kind]} 집행`, () =>
                                    api.executePrivacyRequest(request.id),
                                  )
                                }
                              >
                                {busy ? "집행 중…" : "정말 집행합니다"}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                                취소
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              disabled={busy || request.legal_hold}
                              title={
                                request.legal_hold
                                  ? "보존 의무가 걸려 있어 집행할 수 없습니다"
                                  : `${KIND_LABEL[request.kind]} 집행 — 되돌릴 수 없습니다`
                              }
                              onClick={() => setConfirming(request.id)}
                            >
                              {KIND_LABEL[request.kind]} 집행
                            </Button>
                          ))}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void act(request.id, "완료", () =>
                              api.advancePrivacyRequest(request.id, "completed"),
                            )
                          }
                        >
                          완료 처리
                        </Button>
                      </div>

                      {/* ❗ 보류·거절은 사유가 필수다. 서버가 강제하고 화면도 함께 요구한다. */}
                      <div className="flex items-center gap-2">
                        <input
                          aria-label={`${request.subject_identifier} 보류·거절 사유`}
                          className={inputCls}
                          placeholder="보류·거절 사유 (필수)"
                          value={holdNote[request.id] ?? ""}
                          onChange={(e) =>
                            setHoldNote((prev) => ({ ...prev, [request.id]: e.target.value }))
                          }
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || !(holdNote[request.id] ?? "").trim()}
                          onClick={() =>
                            void act(request.id, "보류", () =>
                              api.advancePrivacyRequest(request.id, "on_hold", holdNote[request.id]),
                            )
                          }
                        >
                          보류
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || !(holdNote[request.id] ?? "").trim()}
                          onClick={() =>
                            void act(request.id, "거절", () =>
                              api.advancePrivacyRequest(request.id, "rejected", holdNote[request.id]),
                            )
                          }
                        >
                          거절
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
