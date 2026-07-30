"use client";

import { useCallback, useEffect, useState } from "react";
import { ContextHeader, HeaderStat } from "@/components/shell/ContextHeader";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState } from "@/components/ui/EmptyState";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { Notice } from "@/components/ui/Notice";
import { api, ApiError, type ApiSettingRow } from "@/lib/data/client";
import { ymd } from "@/lib/data/format";
import { useApi } from "@/lib/data/useApi";

/**
 * 설정 — `/api/settings` · `PUT /api/settings/:key`.
 *
 * ❗ **필드를 화면이 정하지 않는다.** 이전 화면은 `검색 캐시 TTL`·`제외 도메인` 처럼 DB 에
 *    없는 항목을 그리고, 있는 항목은 낡은 기본값(게이트 55 · LLM ₩30,000)으로 보여 줬다.
 *    실제 값은 게이트 60 · LLM ₩15,000 이었다 — 운영자가 화면을 믿으면 잘못된 값을 근거로
 *    판단한다. 그래서 **서버가 준 JSON 을 그대로 펼친다.** 스키마가 바뀌면 화면도 따라간다.
 *
 * ❗ `PUT` 은 키를 **통째로 덮어쓴다** (부분 갱신이 아니다). 그래서 편집 중인 키의 모든
 *    항목을 함께 보낸다 — 한 항목만 보내면 나머지가 사라지고 파서가 기본값으로 되돌린다.
 *
 * ❗ 저장은 admin 전용이다. 권한이 없으면 403 이 오고, 화면은 그 사유를 그대로 보여 준다.
 */

const inputCls =
  "h-8 w-[180px] rounded-tag border border-line bg-canvas px-3 text-[13px] text-fg text-right tabular-nums focus:border-mint focus:outline-none transition-colors duration-150";

/**
 * 설정 항목의 한글 설명.
 *
 * ❗ 여기 없는 키는 **키 이름을 그대로 보여 준다.** 뜻을 모르는 항목에 그럴듯한 설명을
 *    붙이면 그 설명이 곧 오정보가 된다.
 */
const HINT: Record<string, string> = {
  "targets.raw_min": "일일 수집 하한",
  "targets.raw_max": "일일 수집 상한",
  "targets.basic_pass": "기본 제외 통과 목표",
  "targets.review_max": "검수 후보 상한",
  "targets.final_max": "일 승인 상한 (승인일 기준 카운터)",
  "targets.industry_share_max": "단일 업종 비율 상한 (0~1)",
  "targets.rescan_ratio": "재평가 비율 — 신규 소진 대비",
  "targets.cooldown_excluded_days": "제외 업체 재평가 복귀 대기일",
  "targets.cooldown_rejected_days": "검수 제외 후 재평가 대기일",
  "targets.cooldown_recontact_days": "재접촉 대기일",
  "scoring.mode": "배점 모드 (ORS off 면 ors_disabled)",
  "scoring.rule_version": "규칙 버전 — 점수 재현성의 기준",
  "scoring.axis_problem_min": "문제 크기 축 하한",
  "scoring.axis_propensity_min": "구매 가능성 축 하한",
  "scoring.axis_confidence_min": "데이터 신뢰도 축 하한",
  "scoring.total_min_normalized": "100점 환산 통과 기준",
  "cost.daily_cap_krw": "일 비용 상한 — 넘으면 실행을 멈춘다",
  "cost.llm_monthly_cap_krw": "LLM 월 비용 상한",
  "quota.naver_daily_cap": "네이버 일 호출 상한",
  "quota.youtube_daily_units": "YouTube 일 유닛 상한",
  "quota.data_go_kr_daily_cap": "공공데이터포털 일 호출 상한",
  "review.nonce_ttl_minutes": "검수 화면 nonce 유효 시간(분)",
  "review.manual_email_per_minute": "이메일 수동 입력 분당 횟수",
  "privacy.lead_retention_days": "리드 보유 기간(일)",
  "privacy.email_retention_days": "이메일 보유 기간(일)",
  "privacy.default_contact_basis": "기본 접촉 근거",
  "export.max_per_lead": "리드당 export 허용 횟수",
  "schedule.cron": "실행 스케줄 (pg_cron — 아직 미구현)",
  "schedule.enabled": "자동 실행 사용",
  "schedule.timezone": "스케줄 기준 시간대",
  "collection.hira_scope": "HIRA 수집 범위 (name | specialty)",
};

/** 화면 입력값(문자열) → 저장할 JSON 값. **원래 타입으로 되돌린다.** */
function coerce(original: unknown, raw: string): unknown {
  if (typeof original === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`숫자가 아닙니다: ${raw}`);
    return n;
  }
  if (typeof original === "boolean") return raw === "true";
  return raw;
}

const toInput = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "boolean" ? String(value) : String(value ?? "");

type Draft = Record<string, Record<string, string>>;

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 파서를 통과한 적용값. 저장된 JSON 과 다르면 반영되지 않은 것이다. */
function EffectiveBlock({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 border-t border-row pt-3">
      <MonoLabel>적용값 (파서 통과)</MonoLabel>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-baseline justify-between gap-2">
            <dt className="truncate font-mono text-[10px] text-fg-2">{key}</dt>
            <dd className="shrink-0 font-mono text-[11px] tabular-nums text-fg-3">
              {typeof value === "object" ? JSON.stringify(value) : String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function SettingsPage() {
  const settings = useApi(useCallback(() => api.settings(), []), []);
  const [draft, setDraft] = useState<Draft>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ code: string; message: string } | null>(null);

  // 서버 값이 들어오면 편집 버퍼를 그 값으로 초기화한다.
  useEffect(() => {
    const rows = settings.data?.rows;
    if (!rows) return;
    const next: Draft = {};
    for (const row of rows) {
      const bag = objectOf(row.value);
      if (!bag) continue;
      next[row.key] = Object.fromEntries(Object.entries(bag).map(([k, v]) => [k, toInput(v)]));
    }
    setDraft(next);
  }, [settings.data]);

  const save = async (row: ApiSettingRow): Promise<void> => {
    const bag = objectOf(row.value);
    const edited = draft[row.key];
    if (!bag || !edited) return;

    setSavingKey(row.key);
    setSavedKey(null);
    setNotice(null);
    try {
      // ❗ 키 전체를 다시 조립한다 — PUT 은 통째로 덮어쓴다.
      const value: Record<string, unknown> = {};
      for (const [prop, original] of Object.entries(bag)) {
        value[prop] = coerce(original, edited[prop] ?? toInput(original));
      }
      await api.updateSetting(row.key, value);
      setSavedKey(row.key);
      settings.reload();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setNotice({
        code: apiErr?.code ?? "invalid_value",
        message: apiErr?.message ?? (err instanceof Error ? err.message : "저장 중 오류가 발생했습니다."),
      });
    } finally {
      setSavingKey(null);
    }
  };

  const rows = settings.data?.rows ?? [];
  const effective = settings.data?.effective ?? {};

  return (
    <>
      <ContextHeader
        kicker="System"
        title="설정"
        right={
          <>
            <HeaderStat label="Keys" value={String(rows.length)} />
            <MonoLabel>Admin Only</MonoLabel>
          </>
        }
      />
      <main className="flex flex-1 flex-col gap-5 p-8">
        <p className="max-w-[720px] text-[13px] leading-relaxed text-fg-2">
          아래 항목은 <span className="font-mono text-fg-3">settings</span> 테이블이 실제로 들고 있는
          값입니다. 저장은 키 단위로 <span className="font-mono text-fg-3">PUT</span> 하며 해당 키를 통째로
          덮어씁니다. 변경은 다음 실행부터 적용되고, 실행 중인 run 은 시작 시점의{" "}
          <span className="font-mono text-fg-3">settings_snapshot</span> 을 씁니다.
        </p>

        {notice && (
          <Notice kind="error" code={notice.code} message={notice.message} onDismiss={() => setNotice(null)} />
        )}

        {settings.error ? (
          <ErrorState message={`${settings.error.code} — ${settings.error.message}`} />
        ) : settings.loading ? (
          <LoadingState label="Settings" />
        ) : (
          <div className="grid max-w-[1080px] grid-cols-2 gap-5">
            {rows.map((row) => {
              const bag = objectOf(row.value);
              const edited = draft[row.key] ?? {};
              const parsed = objectOf(effective[row.key]);
              return (
                <section key={row.key} className="flex flex-col rounded-card border border-line px-6 py-5">
                  <div className="flex items-baseline justify-between pb-2">
                    <MonoLabel accent>{row.key}</MonoLabel>
                    <span className="text-[11px] text-fg-2">
                      {ymd(row.updated_at)}
                      {row.updated_by === null ? " · seed" : ""}
                    </span>
                  </div>

                  {bag === null ? (
                    <p className="py-2 text-[12px] text-fg-2">
                      객체가 아닌 값입니다 ({JSON.stringify(row.value)}). 이 화면에서 편집할 수 없습니다.
                    </p>
                  ) : (
                    <>
                      {Object.entries(bag).map(([prop, original]) => {
                        const hint = HINT[`${row.key}.${prop}`];
                        const inputId = `${row.key}.${prop}`;
                        return (
                          <label
                            key={prop}
                            htmlFor={inputId}
                            className="flex items-center justify-between gap-4 border-b border-row py-3 last:border-b-0"
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate font-mono text-[12px] text-fg-3">{prop}</span>
                              {hint && <span className="text-[11px] text-fg-2">{hint}</span>}
                            </span>
                            {typeof original === "boolean" ? (
                              <select
                                id={inputId}
                                className={inputCls}
                                value={edited[prop] ?? toInput(original)}
                                onChange={(e) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    [row.key]: { ...prev[row.key], [prop]: e.target.value },
                                  }))
                                }
                              >
                                <option value="true">true</option>
                                <option value="false">false</option>
                              </select>
                            ) : (
                              <input
                                id={inputId}
                                className={inputCls}
                                inputMode={typeof original === "number" ? "decimal" : "text"}
                                value={edited[prop] ?? toInput(original)}
                                onChange={(e) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    [row.key]: { ...prev[row.key], [prop]: e.target.value },
                                  }))
                                }
                              />
                            )}
                          </label>
                        );
                      })}

                      {parsed && <EffectiveBlock values={parsed} />}

                      <div className="flex items-center justify-end gap-3 pt-4">
                        {savedKey === row.key && <MonoLabel accent>Saved</MonoLabel>}
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={savingKey !== null}
                          onClick={() => void save(row)}
                        >
                          {savingKey === row.key ? "저장 중…" : "저장"}
                        </Button>
                      </div>
                    </>
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
