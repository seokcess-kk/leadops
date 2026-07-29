import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Industry,
  INDUSTRY_LABEL,
  projectDepletion,
  type Env,
  type Logger,
  type UniverseCount,
} from "@leadops/core";
import { adapterFor, createSourceAdapters, unverifiedAdapters } from "@leadops/adapters";
import { createHttpClient } from "@leadops/http";
import { renderTable } from "./cli";

/**
 * M0 — 모집단 크기 실측과 소진 곡선 (설계서 결론 D · 9.1절).
 *
 * 이 명령이 Phase 0 의 첫 산출물이다. 법률 검토를 기다릴 필요가 없고,
 * "이 제품이 몇 개월치 리드를 만들 수 있는가" 라는 가장 큰 사업 질문에 답한다.
 *
 * 비용: 업종당 API 호출 1회 (totalCount 만 읽는다).
 */

export interface UniverseReport {
  measuredAt: string;
  sourceMode: Env["FEATURE_SOURCE"];
  unverifiedAdapters: string[];
  counts: UniverseCount[];
  totals: {
    total: number;
    /** eligible 을 아는 업종만 합산한 값. */
    knownEligible: number;
    /** eligible 이 null 인 업종 목록 — 합계가 과소평가임을 알리기 위함. */
    unknownEligibleIndustries: string[];
  };
  projections: Array<{
    newPerDay: number;
    businessDays: number;
    months: number;
  }>;
}

export interface RunUniverseOptions {
  env: Env;
  logger: Logger;
  industries?: readonly Industry[];
  /** 소진 곡선을 그릴 일일 신규 처리량 후보. */
  newPerDayScenarios?: readonly number[];
  outDir?: string;
}

export async function runUniverse(options: RunUniverseOptions): Promise<UniverseReport> {
  const { env, logger } = options;
  const industries = options.industries ?? (Industry.options as readonly Industry[]);
  const scenarios = options.newPerDayScenarios ?? [140, 210, 280, 350];

  const http = createHttpClient(env, { logger });
  const adapters = createSourceAdapters(env, http);
  const unverified = unverifiedAdapters(adapters);

  if (unverified.length > 0) {
    logger.warn("spike.unverified_adapters", { adapters: unverified });
  }

  const counts: UniverseCount[] = [];
  for (const industry of industries) {
    const adapter = adapterFor(adapters, industry);
    logger.info("spike.universe.query", { industry, source: adapter.sourceName });
    counts.push(await adapter.countUniverse(industry));
  }

  const total = counts.reduce((sum, c) => sum + c.total, 0);
  const knownEligible = counts.reduce((sum, c) => sum + (c.eligible ?? 0), 0);
  const unknownEligibleIndustries = counts.filter((c) => c.eligible === null).map((c) => c.industry);

  // 소진 곡선은 eligible 을 모르면 total 로 계산하되, 리포트에 그 사실을 남긴다.
  const basis = unknownEligibleIndustries.length > 0 ? total : knownEligible;

  const report: UniverseReport = {
    measuredAt: new Date().toISOString(),
    sourceMode: env.FEATURE_SOURCE,
    unverifiedAdapters: unverified,
    counts,
    totals: { total, knownEligible, unknownEligibleIndustries },
    projections: scenarios.map((newPerDay) => {
      const p = projectDepletion(basis, newPerDay);
      return { newPerDay, businessDays: p.newExhaustionBusinessDays, months: p.newExhaustionMonths };
    }),
  };

  const outDir = options.outDir ?? env.SPIKE_OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `universe-${report.measuredAt.slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  logger.info("spike.universe.saved", { path: outPath });

  return report;
}

export function formatUniverseReport(report: UniverseReport): string {
  const nf = new Intl.NumberFormat("ko-KR");

  const countRows = report.counts.map((c) => [
    INDUSTRY_LABEL[c.industry],
    c.source,
    nf.format(c.total),
    c.eligible === null ? "미상" : nf.format(c.eligible),
    c.note ?? "",
  ]);

  const projRows = report.projections.map((p) => [
    `${nf.format(p.newPerDay)}건/일`,
    `${nf.format(p.businessDays)} 영업일`,
    `약 ${p.months} 개월`,
  ]);

  const warnings: string[] = [];
  if (report.sourceMode === "mock") {
    warnings.push("⚠️  FEATURE_SOURCE=mock — 이 수치는 목업이며 실제 모집단이 아닙니다.");
  }
  if (report.unverifiedAdapters.length > 0) {
    warnings.push(
      `⚠️  미검증 어댑터: ${report.unverifiedAdapters.join(", ")} — 실 API 응답으로 확인되지 않았습니다.`,
    );
  }
  if (report.totals.unknownEligibleIndustries.length > 0) {
    warnings.push(
      `⚠️  기본 제외 후 잔여 수(eligible)를 모르는 업종: ${report.totals.unknownEligibleIndustries.join(", ")}` +
        " — 소진 곡선은 total 기준이므로 실제보다 낙관적입니다.",
    );
  }

  return [
    "",
    "■ 모집단 크기 (M0)",
    "",
    renderTable(["업종", "소스", "전체", "기본통과 추정", "비고"], countRows),
    "",
    `  합계: ${nf.format(report.totals.total)} 개`,
    "",
    "■ 신규 후보 소진 곡선 (설계서 결론 D)",
    "",
    renderTable(["일 신규 처리량", "소진까지", "환산"], projRows),
    "",
    ...(warnings.length > 0 ? ["■ 경고", "", ...warnings.map((w) => "  " + w), ""] : []),
  ].join("\n");
}
