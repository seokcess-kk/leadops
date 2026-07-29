"use client";

import { useState } from "react";
import { ContextHeader } from "@/components/shell/ContextHeader";
import { Button } from "@/components/ui/Button";
import { MonoLabel } from "@/components/ui/MonoLabel";

const inputCls =
  "h-8 w-[120px] rounded-tag border border-line bg-canvas px-3 text-[13px] text-fg text-right tabular-nums focus:border-mint focus:outline-none transition-colors duration-150";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-4 border-b border-row py-3 last:border-b-0">
      <span className="flex flex-col">
        <span className="text-[13px] text-fg-3">{label}</span>
        {hint && <span className="text-[11px] text-fg-2">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Group({ label, sub, children }: { label: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line px-6 py-5">
      <div className="flex items-baseline justify-between pb-2">
        <MonoLabel accent>{label}</MonoLabel>
        <span className="text-[11px] text-fg-2">{sub}</span>
      </div>
      {children}
    </section>
  );
}

/**
 * 설정 (admin).
 * 절제 다크 폼 — 강조 없음. 변경은 다음 실행부터 적용되며 run 별로
 * settings_snapshot 에 동결된다 (§8.3).
 */
export default function SettingsPage() {
  const [saved, setSaved] = useState(false);

  return (
    <>
      <ContextHeader kicker="System" title="설정" right={<MonoLabel>Admin Only</MonoLabel>} />
      <main className="flex flex-1 flex-col gap-5 p-8">
        <div className="grid max-w-[1080px] grid-cols-2 gap-5">
          <Group label="Schedule" sub="실행 스케줄">
            <Field label="자동 실행" hint="pg_cron → HMAC 서명 트리거">
              <select className={inputCls} defaultValue="06:00">
                <option>06:00</option>
                <option>07:00</option>
                <option>수동</option>
              </select>
            </Field>
            <Field label="일일 수집량" hint="targets.raw_min ~ raw_max">
              <span className="flex items-center gap-2">
                <input className={inputCls} defaultValue={300} />
                <span className="text-fg-2">~</span>
                <input className={inputCls} defaultValue={500} />
              </span>
            </Field>
            <Field label="재평가 비율" hint="targets.rescan_ratio — 신규 소진 대비">
              <input className={inputCls} defaultValue="30%" />
            </Field>
            <Field label="제외 cooldown" hint="제외 업체 재평가 복귀 대기일">
              <input className={inputCls} defaultValue="45일" />
            </Field>
          </Group>

          <Group label="Scoring" sub="3축 가중치 · 게이트">
            <Field label="문제 크기 배점" hint="axis_problem 상한">
              <input className={inputCls} defaultValue={60} />
            </Field>
            <Field label="구매 가능성 배점" hint="axis_propensity 상한">
              <input className={inputCls} defaultValue={25} />
            </Field>
            <Field label="데이터 신뢰도 배점" hint="axis_confidence 상한">
              <input className={inputCls} defaultValue={15} />
            </Field>
            <Field label="검수 게이트 총점" hint="미만이면 후보 제외">
              <input className={inputCls} defaultValue={55} />
            </Field>
            <Field label="단일 업종 상한" hint="targets.industry_share_max">
              <input className={inputCls} defaultValue="60%" />
            </Field>
          </Group>

          <Group label="Quota · Cost" sub="쿼터·비용 상한">
            <Field label="네이버 쿼터 상한" hint="일 25,000회 합산 한도 내 사용 상한">
              <input className={inputCls} defaultValue="20,000" />
            </Field>
            <Field label="LLM 월 비용 상한" hint="초과 시 FEATURE_LLM=off 폴백">
              <input className={inputCls} defaultValue="₩30,000" />
            </Field>
            <Field label="검색 캐시 TTL" hint="동일 키워드 재조회 방지">
              <input className={inputCls} defaultValue="7일" />
            </Field>
            <Field label="일일 승인 상한" hint="targets.final_max — 승인일 기준 카운터">
              <input className={inputCls} defaultValue={50} />
            </Field>
          </Group>

          <Group label="Exclusion" sub="제외 도메인">
            <p className="pb-2 text-[11px] leading-relaxed text-fg-2">
              홈페이지 판별에서 무시할 도메인 (플랫폼·포털·병원 네트워크 본원 등). 줄바꿈으로 구분.
            </p>
            <textarea
              aria-label="제외 도메인 목록"
              rows={7}
              className="w-full resize-none rounded-tag border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed text-fg-3 focus:border-mint focus:outline-none"
              defaultValue={"blog.naver.com\nmodoo.at\ncafe24.com\nimweb.me"}
            />
          </Group>
        </div>

        <div className="flex max-w-[1080px] items-center justify-between">
          <p className="text-[11px] text-fg-2">
            변경은 다음 실행부터 적용됩니다 — 실행 중 run 은 시작 시점의 settings_snapshot 을 사용합니다.
          </p>
          <span className="flex items-center gap-3">
            {saved && <MonoLabel accent>Saved</MonoLabel>}
            <Button variant="primary" onClick={() => setSaved(true)}>저장</Button>
          </span>
        </div>
      </main>
    </>
  );
}
