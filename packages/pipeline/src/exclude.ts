import type { CompanyStatus, RawCandidate } from "@leadops/core";

/**
 * 기본 제외 규칙 (설계서 5.3 스테이지 4).
 *
 * 폐업·휴업, 대형 업체, 가맹점 100개 이상 가맹본부를 걸러낸다.
 *
 * 원칙: **제외 사유를 항상 남긴다.** "왜 이 업체가 안 나왔나" 는 운영에서 가장
 * 자주 나오는 질문이고, 사유가 없으면 답할 수 없다.
 */

export interface ExcludeSettings {
  /** 가맹점 수 상한. 초과하면 제외. 설계서 1.5 기본 100. */
  franchiseStoreLimit: number;
  /** 의사 수 상한. 초과하면 대형으로 보고 제외. */
  doctorCountLimit: number;
  /** 지점 수 상한. */
  branchCountLimit: number;
}

export const DEFAULT_EXCLUDE_SETTINGS: ExcludeSettings = {
  franchiseStoreLimit: 100,
  doctorCountLimit: 20,
  branchCountLimit: 10,
};

export type ExcludeReason =
  | "closed"
  | "suspended"
  | "franchise_too_large"
  | "too_many_doctors"
  | "too_many_branches"
  | "not_headquarters"
  | "missing_name";

export interface ExcludeDecision {
  excluded: boolean;
  reason?: ExcludeReason;
  /** 사람이 읽을 설명. 검수 화면에 그대로 보여준다. */
  detail?: string;
  /** 규모 등급. 제외되지 않아도 점수 계산에 쓴다. */
  sizeTier: "small" | "mid" | "large";
}

/**
 * 규모 등급.
 *
 * 의사 수와 가맹점 수를 각각의 축으로 본다. 둘 중 큰 쪽을 따른다.
 */
export function classifySize(
  signals: Readonly<Record<string, number>>,
  settings: ExcludeSettings,
): "small" | "mid" | "large" {
  const doctors = signals["doctorCount"] ?? 0;
  const stores = signals["storeCount"] ?? 0;
  const branches = signals["branchCount"] ?? 0;

  if (doctors > settings.doctorCountLimit || stores > settings.franchiseStoreLimit || branches > settings.branchCountLimit) {
    return "large";
  }
  if (doctors >= 5 || stores >= 20 || branches >= 3) return "mid";
  return "small";
}

export function decideExclusion(
  candidate: RawCandidate,
  settings: ExcludeSettings = DEFAULT_EXCLUDE_SETTINGS,
): ExcludeDecision {
  const sizeTier = classifySize(candidate.sizeSignals, settings);

  if (candidate.name.trim().length === 0) {
    return { excluded: true, reason: "missing_name", detail: "업체명이 비어 있습니다", sizeTier };
  }

  const status: CompanyStatus = candidate.status;
  if (status === "closed") {
    return { excluded: true, reason: "closed", detail: "폐업 상태입니다", sizeTier };
  }
  if (status === "suspended") {
    return { excluded: true, reason: "suspended", detail: "휴업 상태입니다", sizeTier };
  }

  const stores = candidate.sizeSignals["storeCount"];
  if (candidate.industry === "franchise" && stores !== undefined && stores >= settings.franchiseStoreLimit) {
    return {
      excluded: true,
      reason: "franchise_too_large",
      detail: `가맹점 ${stores}개로 상한(${settings.franchiseStoreLimit})을 넘습니다`,
      sizeTier,
    };
  }

  const doctors = candidate.sizeSignals["doctorCount"];
  if (doctors !== undefined && doctors > settings.doctorCountLimit) {
    return {
      excluded: true,
      reason: "too_many_doctors",
      detail: `의사 ${doctors}명으로 상한(${settings.doctorCountLimit})을 넘습니다`,
      sizeTier,
    };
  }

  const branches = candidate.sizeSignals["branchCount"];
  if (branches !== undefined && branches > settings.branchCountLimit) {
    return {
      excluded: true,
      reason: "too_many_branches",
      detail: `지점 ${branches}개로 상한(${settings.branchCountLimit})을 넘습니다`,
      sizeTier,
    };
  }

  return { excluded: false, sizeTier };
}

/**
 * 설정 스냅샷에서 제외 기준을 읽는다.
 *
 * 값이 없으면 기본값을 쓰되, **형식이 틀리면 조용히 기본값으로 넘어가지 않고 던진다.**
 * 설정 오타 때문에 상한이 사라지는 것이 가장 나쁜 실패다.
 */
export function excludeSettingsFrom(snapshot: unknown): ExcludeSettings {
  const targets = (snapshot as { targets?: Record<string, unknown> } | null)?.targets;
  const read = (key: string, fallback: number): number => {
    const v = targets?.[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`설정 targets.${key} 가 양수가 아닙니다: ${JSON.stringify(v)}`);
    }
    return v;
  };
  return {
    franchiseStoreLimit: read("franchise_store_limit", DEFAULT_EXCLUDE_SETTINGS.franchiseStoreLimit),
    doctorCountLimit: read("doctor_count_limit", DEFAULT_EXCLUDE_SETTINGS.doctorCountLimit),
    branchCountLimit: read("branch_count_limit", DEFAULT_EXCLUDE_SETTINGS.branchCountLimit),
  };
}
