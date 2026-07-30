"use client";

import { useCallback, useMemo, useState } from "react";
import { ContextHeader, HeaderStat } from "@/components/shell/ContextHeader";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState } from "@/components/ui/EmptyState";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { Notice } from "@/components/ui/Notice";
import { api, ApiError, type ApiKeywordRow } from "@/lib/data/client";
import { count } from "@/lib/data/format";
import { useApi } from "@/lib/data/useApi";
import { INDUSTRY_LABEL, type Industry } from "@/lib/data/types";

/** 목록 상한. 서버의 `PAGE_MAX` 와 같다 — 넘으면 잘렸다는 사실을 화면에 남긴다. */
const KEYWORD_LIMIT = 200;

const industryLabel = (key: string): string =>
  key in INDUSTRY_LABEL ? INDUSTRY_LABEL[key as Industry] : key;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-end">
      <span className="k-label text-[9px]">{label}</span>
      <span className="display-num text-[24px] text-fg">{value}</span>
    </div>
  );
}

/**
 * 업종 · 키워드 — `/api/industries` · `/api/keywords`.
 *
 * ❗ 키워드는 **업체별 구체 키워드**(`company_keywords`)다. fixture 가 보여 주던
 *    `{업체명} {지역}` 형태의 *템플릿* 은 DB 에 없는 개념이라 화면에서 없앴다 — 없는 것을
 *    있는 것처럼 그리면 운영자가 편집할 수 있다고 믿는다.
 *
 * ❗ 키워드는 `search_analyze` 스테이지가 만든다. `FEATURE_ORS=off` 면 그 스테이지를 건너뛰므로
 *    **키워드가 하나도 없는 것이 정상**이다. 빈 목록에 사유를 남긴다.
 */
export default function IndustriesPage() {
  const [notice, setNotice] = useState<{ code: string; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const industries = useApi(useCallback(() => api.industries(), []), []);
  const keywords = useApi(
    useCallback(() => api.keywords(undefined, false, KEYWORD_LIMIT), []),
    [],
  );

  const rows = industries.data ?? [];
  const keywordRows = keywords.data ?? [];

  const byIndustry = useMemo(() => {
    const map = new Map<string, ApiKeywordRow[]>();
    for (const row of keywordRows) {
      const bucket = map.get(row.industry);
      if (bucket) bucket.push(row);
      else map.set(row.industry, [row]);
    }
    return map;
  }, [keywordRows]);

  const totalCompanies = rows.reduce((sum, row) => sum + row.companies, 0);
  const keywordsTruncated = keywordRows.length >= KEYWORD_LIMIT;

  const approve = async (id: string): Promise<void> => {
    setBusyId(id);
    setNotice(null);
    try {
      await api.approveKeyword(id, true);
      keywords.reload();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setNotice({
        code: apiErr?.code ?? "unknown",
        message: apiErr?.message ?? "키워드 승인 중 오류가 발생했습니다.",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <ContextHeader
        kicker="System"
        title="업종 · 키워드"
        right={<HeaderStat label="Companies" value={count(totalCompanies)} />}
      />
      <main className="flex flex-1 flex-col gap-6 p-8">
        <p className="max-w-[720px] text-[13px] leading-relaxed text-fg-2">
          모집단은 유한합니다 (설계서 결론 D). 아래 수치는 수집된 업체 기준이며, &ldquo;발굴 가능&rdquo;은
          기본 제외(폐업·휴업·대형·가맹 100+) 이후 남은 수, &ldquo;공식 홈페이지&rdquo;는 URL 존재가 아니라
          공식(confirmed·likely) 판정을 받은 수입니다. 키워드는 승인 후에만 검색에 사용됩니다.
        </p>

        {notice && (
          <Notice kind="error" code={notice.code} message={notice.message} onDismiss={() => setNotice(null)} />
        )}
        {keywords.error && (
          <Notice
            kind="error"
            code={keywords.error.code}
            message={`키워드를 불러오지 못했습니다 — ${keywords.error.message}`}
            action={{ label: "다시 불러오기", onClick: keywords.reload }}
          />
        )}
        {keywordsTruncated && (
          <Notice
            kind="info"
            code="truncated"
            message={`키워드를 ${KEYWORD_LIMIT}건까지만 불러왔습니다 (서버 페이지 상한). 아래 목록은 전체가 아닙니다.`}
          />
        )}

        {industries.error ? (
          <ErrorState message={`${industries.error.code} — ${industries.error.message}`} />
        ) : industries.loading ? (
          <LoadingState label="Industries" />
        ) : rows.length === 0 ? (
          <Notice
            kind="info"
            code="no companies"
            message="수집된 업체가 없습니다. 워커를 한 번 실행하면 업종별 집계가 채워집니다."
          />
        ) : (
          <div className="grid grid-cols-2 gap-5">
            {rows.map((row) => {
              const items = byIndustry.get(row.industry) ?? [];
              return (
                <section key={row.industry} className="flex flex-col rounded-card border border-line">
                  <div className="flex items-end justify-between border-b border-line px-5 py-4">
                    <div className="flex flex-col gap-0.5">
                      <MonoLabel accent>{row.industry}</MonoLabel>
                      <h2 className="text-[15px] font-semibold text-fg">{industryLabel(row.industry)}</h2>
                    </div>
                    <div className="flex gap-5">
                      <Stat label="모집단" value={count(row.companies)} />
                      <Stat label="발굴 가능" value={count(row.active)} />
                      <Stat label="공식 홈페이지" value={count(row.with_homepage)} />
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-b border-row px-5 py-2.5 text-[11px] text-fg-2">
                    <span>
                      리드 <span className="font-mono tabular-nums text-fg-3">{count(row.leads)}</span>
                      <span className="text-fg-2"> / 업종 쿼터 {count(row.quota)}</span>
                    </span>
                    <span>
                      키워드 <span className="font-mono tabular-nums text-fg-3">{count(row.keywords)}</span>
                      {row.llm_pending > 0 && (
                        <span className="text-violet-bright"> · LLM 미승인 {count(row.llm_pending)}</span>
                      )}
                    </span>
                  </div>

                  {items.length === 0 ? (
                    <p className="px-5 py-4 text-[12px] leading-relaxed text-fg-2">
                      {row.keywords === 0
                        ? "키워드가 없습니다. 키워드는 search_analyze 스테이지가 만들고, FEATURE_ORS=off 면 그 스테이지를 건너뜁니다."
                        : "이 업종의 키워드가 위 목록 상한 밖에 있습니다."}
                    </p>
                  ) : (
                    <ul className="flex flex-col px-5 py-2">
                      {items.map((kw) => (
                        <li
                          key={kw.id}
                          className="flex items-center justify-between gap-3 border-b border-row py-2.5 last:border-b-0"
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-[13px] text-fg-3">{kw.keyword}</span>
                            <span className="truncate text-[10px] text-fg-2">
                              {kw.company_name} · {kw.kind}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {kw.source === "llm" && (
                              <span className="mono-label text-[8px] text-violet-bright">LLM Draft</span>
                            )}
                            {kw.approved ? (
                              <span className="mono-label text-[8px] text-mint">Approved</span>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2.5 text-[9px]"
                                disabled={busyId === kw.id}
                                onClick={() => void approve(kw.id)}
                              >
                                승인
                              </Button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
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
