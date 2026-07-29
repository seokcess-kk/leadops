import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adapterFor, createSourceAdapters, unverifiedAdapters } from "@leadops/adapters";
import { Industry, INDUSTRY_LABEL, type Env, type Logger, type RawCandidate } from "@leadops/core";
import { createHttpClient } from "@leadops/http";
import { renderTable } from "./cli";

/**
 * 표본 추출 (설계서 9.1절).
 *
 * 업종별 n=30, 지역 층화(서울 15 / 광역시 8 / 그 외 7). 추출 결과는 CSV 로 고정해
 * 골드셋 라벨링의 입력으로 쓴다. 재현 가능해야 하므로 시드를 받는다.
 */

export const DEFAULT_STRATA: ReadonlyArray<{ key: string; quota: number; match: (c: RawCandidate) => boolean }> = [
  { key: "서울", quota: 15, match: (c) => (c.regionSido ?? "").includes("서울") },
  {
    key: "광역시",
    quota: 8,
    match: (c) => /부산|대구|인천|광주|대전|울산/.test(c.regionSido ?? ""),
  },
  { key: "그 외", quota: 7, match: () => true },
];

/** 결정적 PRNG (mulberry32). 같은 시드 → 같은 표본. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface StratifiedResult {
  picked: RawCandidate[];
  perStratum: Record<string, number>;
  shortfall: Record<string, number>;
}

/**
 * 층화 표본 추출.
 *
 * 층별 할당량을 채우지 못하면 **조용히 다른 층에서 메우지 않고** 부족분을 보고한다.
 * 표본이 설계대로 뽑히지 않았다는 사실 자체가 결과 해석에 중요하기 때문이다.
 */
export function stratifiedSample(
  candidates: readonly RawCandidate[],
  rand: () => number,
  strata = DEFAULT_STRATA,
): StratifiedResult {
  const shuffled = shuffle(candidates, rand);
  const used = new Set<string>();
  const picked: RawCandidate[] = [];
  const perStratum: Record<string, number> = {};
  const shortfall: Record<string, number> = {};

  for (const stratum of strata) {
    let taken = 0;
    for (const c of shuffled) {
      if (taken >= stratum.quota) break;
      if (used.has(c.externalId)) continue;
      if (!stratum.match(c)) continue;
      used.add(c.externalId);
      picked.push(c);
      taken++;
    }
    perStratum[stratum.key] = taken;
    if (taken < stratum.quota) shortfall[stratum.key] = stratum.quota - taken;
  }

  return { picked, perStratum, shortfall };
}

export interface SampleReport {
  measuredAt: string;
  sourceMode: Env["FEATURE_SOURCE"];
  unverifiedAdapters: string[];
  seed: number;
  perIndustry: Array<{
    industry: Industry;
    fetched: number;
    picked: number;
    perStratum: Record<string, number>;
    shortfall: Record<string, number>;
  }>;
  csvPath: string;
}

export interface RunSampleOptions {
  env: Env;
  logger: Logger;
  industries?: readonly Industry[];
  /** 업종당 표본 수. 기본 30. */
  perIndustry?: number;
  /** 층화 전에 읽어올 후보 수. 기본 표본 수의 10배. */
  poolSize?: number;
  seed?: number;
  outDir?: string;
}

export async function runSample(options: RunSampleOptions): Promise<SampleReport> {
  const { env, logger } = options;
  const industries = options.industries ?? (Industry.options as readonly Industry[]);
  const perIndustryTarget = options.perIndustry ?? 30;
  const poolSize = options.poolSize ?? perIndustryTarget * 10;
  const seed = options.seed ?? 20260729;

  const http = createHttpClient(env, { logger });
  const adapters = createSourceAdapters(env, http);

  const rows: string[] = [
    // 골드셋 라벨링용 CSV. 사람이 채울 열을 미리 비워 둔다.
    [
      "industry",
      "source",
      "external_id",
      "name",
      "region_sido",
      "region_sigungu",
      "address",
      "phone",
      "homepage_url_hint",
      // ↓ 사람이 채우는 열 (설계서 9.1 M1~M3b)
      "label_official_url",
      "label_official_status",
      "label_has_business_email",
      "label_email_location",
      "label_notes",
    ].join(","),
  ];

  const perIndustry: SampleReport["perIndustry"] = [];

  for (const industry of industries) {
    const adapter = adapterFor(adapters, industry);
    const pool: RawCandidate[] = [];
    for await (const c of adapter.fetchCandidates(industry, { limit: poolSize })) pool.push(c);

    const quotaScale = perIndustryTarget / 30;
    const strata = DEFAULT_STRATA.map((s) => ({ ...s, quota: Math.round(s.quota * quotaScale) }));
    const result = stratifiedSample(pool, mulberry32(seed + industry.length), strata);

    logger.info("spike.sample.industry", {
      industry,
      fetched: pool.length,
      picked: result.picked.length,
      shortfall: result.shortfall,
    });

    for (const c of result.picked) {
      rows.push(
        [
          c.industry,
          c.source,
          c.externalId,
          c.name,
          c.regionSido ?? "",
          c.regionSigungu ?? "",
          c.address ?? "",
          c.phone ?? "",
          c.homepageUrl ?? "",
          "", "", "", "", "",
        ]
          .map(csvCell)
          .join(","),
      );
    }

    perIndustry.push({
      industry,
      fetched: pool.length,
      picked: result.picked.length,
      perStratum: result.perStratum,
      shortfall: result.shortfall,
    });
  }

  const outDir = options.outDir ?? env.SPIKE_OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const csvPath = join(outDir, `sample-seed${seed}.csv`);
  // BOM 을 붙여 Excel 에서 한글이 깨지지 않게 한다.
  writeFileSync(csvPath, "﻿" + rows.join("\n"), "utf8");
  logger.info("spike.sample.saved", { path: csvPath, rows: rows.length - 1 });

  return {
    measuredAt: new Date().toISOString(),
    sourceMode: env.FEATURE_SOURCE,
    unverifiedAdapters: unverifiedAdapters(adapters),
    seed,
    perIndustry,
    csvPath,
  };
}

export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatSampleReport(report: SampleReport): string {
  const rows = report.perIndustry.map((p) => [
    INDUSTRY_LABEL[p.industry],
    String(p.fetched),
    String(p.picked),
    Object.entries(p.perStratum).map(([k, v]) => `${k} ${v}`).join(" / "),
    Object.keys(p.shortfall).length === 0
      ? "-"
      : Object.entries(p.shortfall).map(([k, v]) => `${k} ${v}건 부족`).join(", "),
  ]);

  const total = report.perIndustry.reduce((s, p) => s + p.picked, 0);
  const anyShortfall = report.perIndustry.some((p) => Object.keys(p.shortfall).length > 0);

  return [
    "",
    "■ 표본 추출 (설계서 9.1)",
    "",
    renderTable(["업종", "풀", "선정", "층별", "부족분"], rows),
    "",
    `  총 ${total} 건 → ${report.csvPath}`,
    `  시드 ${report.seed} (같은 시드로 재실행하면 같은 표본이 나옵니다)`,
    "",
    ...(anyShortfall
      ? ["  ⚠️  일부 층의 할당량을 채우지 못했습니다. 다른 층에서 메우지 않았으므로", "     결과 해석 시 층 구성 편향을 감안하세요.", ""]
      : []),
    ...(report.sourceMode === "mock" ? ["  ⚠️  FEATURE_SOURCE=mock — 목업 표본입니다.", ""] : []),
  ].join("\n");
}
