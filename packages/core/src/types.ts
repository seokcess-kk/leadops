import { z } from "zod";

/** 초기 업종. 설계서 1.5절. */
export const Industry = z.enum(["derm", "plastic", "dental", "franchise"]);
export type Industry = z.infer<typeof Industry>;

export const INDUSTRY_LABEL: Record<Industry, string> = {
  derm: "피부과",
  plastic: "성형외과",
  dental: "치과",
  franchise: "프랜차이즈 가맹본부",
};

export const CompanyStatus = z.enum(["active", "suspended", "closed", "unknown"]);
export type CompanyStatus = z.infer<typeof CompanyStatus>;

export const OfficialStatus = z.enum(["confirmed", "likely", "uncertain", "not_official", "unavailable"]);
export type OfficialStatus = z.infer<typeof OfficialStatus>;

/**
 * 수집 원본 후보.
 *
 * ❗ 이메일 필드가 없다. 홈페이지에서 프로그램으로 이메일을 수집하지 않기 때문이다
 *    (정보통신망법 제50조의2 · 설계서 결론 A).
 *    공공 API 가 이메일을 **필드로** 제공하는 경우에만 `publicApiEmail` 에 담고,
 *    출처를 `publicApiEmailSource` 에 반드시 기록한다.
 */
export const RawCandidate = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  industry: Industry,

  name: z.string().min(1),
  bizNo: z.string().optional(),
  corpNo: z.string().optional(),

  address: z.string().optional(),
  regionSido: z.string().optional(),
  regionSigungu: z.string().optional(),
  regionDong: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),

  phone: z.string().optional(),
  homepageUrl: z.string().optional(),

  status: CompanyStatus.default("unknown"),

  /** 규모 판정 신호. 의사 수, 가맹점 수, 지점 수 등. */
  sizeSignals: z.record(z.string(), z.number()).default({}),

  /** 공공 API 가 필드로 제공한 이메일 (스크래핑 아님). */
  publicApiEmail: z.string().optional(),
  publicApiEmailSource: z.string().optional(),

  /** 어댑터가 받은 원본. 디버깅·감사용. */
  raw: z.unknown(),
});
export type RawCandidate = z.infer<typeof RawCandidate>;

/** 모집단 크기 실측 결과 (설계서 결론 D · M0). */
export interface UniverseCount {
  industry: Industry;
  source: string;
  total: number;
  /** 기본 제외(폐업·휴업·대형·가맹점 100+) 적용 후 남는 수. 알 수 없으면 null. */
  eligible: number | null;
  measuredAt: string;
  note?: string;
}

/** 소진 곡선 산출 결과. */
export interface DepletionProjection {
  universeEligible: number;
  newPerDay: number;
  /** 신규 후보가 고갈되기까지 남은 영업일. */
  newExhaustionBusinessDays: number;
  /** 대략적인 달력 개월 수 (영업일 22일/월 가정). */
  newExhaustionMonths: number;
}

export function projectDepletion(universeEligible: number, newPerDay: number): DepletionProjection {
  if (newPerDay <= 0) throw new Error("newPerDay must be > 0");
  const days = Math.ceil(universeEligible / newPerDay);
  return {
    universeEligible,
    newPerDay,
    newExhaustionBusinessDays: days,
    newExhaustionMonths: Math.round((days / 22) * 10) / 10,
  };
}
