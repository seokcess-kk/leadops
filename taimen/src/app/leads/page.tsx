"use client";

import { useMemo, useState } from "react";
import { ContextHeader, HeaderStat } from "@/components/shell/ContextHeader";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { StatusTag } from "@/components/ui/StatusTag";
import { api, ApiError, type ApiExportRow } from "@/lib/data/client";
import { downloadCsv, toCsv, type CsvColumn } from "@/lib/data/csv";
import { seoulToday, useReview } from "@/lib/data/store";
import {
  INDUSTRY_LABEL,
  LEAD_STATUS_ORDER,
  type Industry,
  type LeadStatus,
} from "@/lib/data/types";

/** `_watermark` 를 마지막 두 열로 둔다 — 데이터와 함께 움직여야 출처를 되짚을 수 있다. */
const EXPORT_COLUMNS: ReadonlyArray<CsvColumn<ApiExportRow>> = [
  { header: "업체명", value: (r) => r.company_name },
  { header: "업종", value: (r) => r.industry },
  { header: "시도", value: (r) => r.region_sido },
  { header: "시군구", value: (r) => r.region_sigungu },
  { header: "이메일", value: (r) => r.email },
  { header: "점수", value: (r) => r.score },
  { header: "접촉근거", value: (r) => r.contact_legal_basis },
  { header: "리드ID", value: (r) => r.id },
  { header: "exported_by", value: (r) => r._watermark?.exported_by },
  { header: "exported_at", value: (r) => r._watermark?.exported_at },
];

/** 기본 범위: 최근 30일. `leads.created_at` 기준이다. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(d);
}

/**
 * 승인 리드.
 * 상태는 READY → … → WON/LOST 8단계 모노 pill — 향후 Outreach·Pipeline 모듈이
 * 이 상태를 전이시킨다. 과도한 컬러 배지 없이 READY·WON·LOST 만 유채색.
 */
export default function LeadsPage() {
  const { state, actions } = useReview();
  const [status, setStatus] = useState<LeadStatus | "all">("all");
  const [industry, setIndustry] = useState<Industry | "all">("all");
  const [from, setFrom] = useState(() => daysAgo(30));
  const [to, setTo] = useState(() => seoulToday());
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; code: string; message: string } | null>(null);

  /**
   * ❗ 화면이 CSV 를 **만들기만** 한다. 어떤 리드를 내보낼 수 있는지는 `export_leads()` 가
   *    정한다 (접촉 근거·수신거부·보유기간·횟수 상한·감사 기록). 여기서 필터를 흉내 내면
   *    화면 필터를 우회해 내보낼 수 있는 경로가 생긴다 — 그래서 화면 필터를 보내지 않는다.
   * ❗ 상한에 걸린 리드는 RPC 가 조용히 뺀다. 요청 범위의 건수가 아니라 **실제로 내보내진
   *    건수**를 알려 준다. 0 건이면 왜 0 인지 짚어 준다.
   */
  const runExport = async (): Promise<void> => {
    setExporting(true);
    setNotice(null);
    try {
      const result = await api.leadsExport(from, to);
      const rows = result.data;
      if (rows.length === 0) {
        setNotice({
          kind: "info",
          code: "nothing_exported",
          message:
            "내보낼 리드가 없습니다. 범위 안에 승인 리드가 없거나, 접촉 근거·보유기간·수신거부·export 횟수 상한에 걸렸습니다.",
        });
        return;
      }
      downloadCsv(`leadops-leads-${from}_${to}.csv`, toCsv(rows, EXPORT_COLUMNS));
      setNotice({ kind: "info", code: "exported", message: `${rows.length}건을 내보냈습니다.` });
      // export 는 `export_status`·`export_count` 를 바꾼다. 목록을 다시 읽는다.
      await actions.refresh();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setNotice({
        kind: "error",
        code: apiErr?.code ?? "unknown",
        message: apiErr?.message ?? "export 중 오류가 발생했습니다.",
      });
    } finally {
      setExporting(false);
    }
  };

  const filtered = useMemo(
    () =>
      state.leads.filter(
        (lead) =>
          (status === "all" || lead.status === status) &&
          (industry === "all" || lead.industry === industry),
      ),
    [state.leads, status, industry],
  );

  const wonCount = state.leads.filter((lead) => lead.status === "WON").length;
  const th = "px-3 py-2.5 text-left k-label whitespace-nowrap";
  const selectCls =
    "h-8 rounded-tag border border-line bg-canvas px-3 text-[13px] text-fg appearance-none pr-8 focus:border-mint focus:outline-none transition-colors duration-150";

  return (
    <>
      <ContextHeader
        kicker="Approved"
        title="승인 리드"
        right={
          <>
            <HeaderStat label="Total" value={String(state.leads.length)} />
            <HeaderStat label="Won" value={String(wonCount)} accent={wonCount > 0} />
          </>
        }
      />
      <main className="flex flex-1 flex-col gap-5 p-8">
        {/* 상태 필터 — 모노 pill 스트립 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setStatus("all")}
            className={`h-[26px] cursor-pointer rounded-full border px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] transition-colors duration-150 ${
              status === "all" ? "border-mint text-mint" : "border-line text-fg-2 hover:text-hoverlink"
            }`}
          >
            All
          </button>
          {LEAD_STATUS_ORDER.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`h-[26px] cursor-pointer rounded-full border px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] transition-colors duration-150 ${
                status === s ? "border-mint text-mint" : "border-line text-fg-2 hover:text-hoverlink"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <select
            aria-label="업종 필터"
            className={selectCls}
            value={industry}
            onChange={(e) => setIndustry(e.target.value as Industry | "all")}
          >
            <option value="all">업종 전체</option>
            {(Object.keys(INDUSTRY_LABEL) as Industry[]).map((key) => (
              <option key={key} value={key}>{INDUSTRY_LABEL[key]}</option>
            ))}
          </select>
          <div className="flex items-center gap-3">
            <span className="k-label">Export: 워터마크 · 감사 기록 · 횟수 제한</span>
            <input
              type="date"
              aria-label="export 시작일"
              className={selectCls}
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span className="text-fg-2">~</span>
            <input
              type="date"
              aria-label="export 종료일"
              className={selectCls}
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
            <Button size="sm" variant="outline" disabled={exporting} onClick={() => void runExport()}>
              {exporting ? "내보내는 중…" : "CSV Export"}
            </Button>
          </div>
        </div>

        {notice && (
          <Notice
            kind={notice.kind}
            code={notice.code}
            message={notice.message}
            onDismiss={() => setNotice(null)}
          />
        )}

        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full border-collapse text-[13px]">
            <thead className="bg-subtle">
              <tr className="border-b border-line">
                <th className={`${th} pl-4`}>업체명</th>
                <th className={th}>업종</th>
                <th className={th}>지역</th>
                <th className={th}>이메일</th>
                <th className={th}>점수</th>
                <th className={th}>승인일</th>
                <th className={`${th} pr-4`}>상태</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((lead) => (
                <tr
                  key={lead.id}
                  className="h-11 border-b border-row transition-colors duration-100 last:border-b-0 hover:bg-subtle"
                >
                  <td className="max-w-[200px] truncate px-3 pl-4 font-medium text-fg">{lead.companyName}</td>
                  <td className="whitespace-nowrap px-3 text-fg-2">{INDUSTRY_LABEL[lead.industry]}</td>
                  <td className="whitespace-nowrap px-3 text-fg-2">{lead.region}</td>
                  <td className="max-w-[200px] truncate px-3 text-xs text-fg-3">{lead.email}</td>
                  <td className="px-3">
                    <span className={`font-mono text-[13px] font-bold tabular-nums ${lead.score >= 80 ? "text-mint" : "text-fg"}`}>
                      {lead.score}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 font-mono text-[11px] tabular-nums text-fg-2">
                    {lead.approvedAt}
                  </td>
                  <td className="px-3 pr-4">
                    <StatusTag status={lead.status} />
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <span className="k-label">조건에 맞는 리드 없음</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-fg-2">
          상태 전이(발송·회신·미팅·수주)는 Outreach · Pipeline 모듈에서 제공 예정입니다.
          승인 스냅샷(점수·근거)은 승인 시점 기준으로 동결됩니다.
        </p>
      </main>
    </>
  );
}
