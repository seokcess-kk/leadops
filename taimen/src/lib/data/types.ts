/**
 * leadops 도메인 타입.
 *
 * 상위 모노레포 설계서 v3(../docs/00-plan.md) §6 ERD·§7.2 HTTP API 계약을 따른다.
 * packages/core/src/types.ts 의 Industry·OfficialStatus 정의와 일치시킨다.
 *
 * ❗ 카피 규정 (설계서 결론 C): UI 에서 "검색 노출·순위·점유율" 표현 금지.
 *    ORS 는 "네이버 Open API 기준 콘텐츠 회수 점유"로만 표기한다.
 * ❗ 이메일은 시스템이 수집하지 않는다 (정보통신망법 제50조의2 · 결론 A).
 *    검수자가 연락처 페이지에서 확인해 수동 입력하고, 문법→DNS→MX 검증을 통과해야
 *    승인이 가능하다.
 */

export type Industry = "derm" | "plastic" | "dental" | "franchise";

export const INDUSTRY_LABEL: Record<Industry, string> = {
  derm: "피부과",
  plastic: "성형외과",
  dental: "치과",
  franchise: "프랜차이즈",
};

export type OfficialStatus = "confirmed" | "likely" | "uncertain" | "not_official" | "unavailable";

/** 3축 점수 (F-21). 문제 크기 0~60 / 구매 가능성 0~25 / 데이터 신뢰도 0~15. */
export interface AxisScore {
  problem: number;
  propensity: number;
  confidence: number;
  total: number;
}

export const AXIS_MAX = { problem: 60, propensity: 25, confidence: 15 } as const;

export interface Weakness {
  kind: string;
  label: string;
  severity: "high" | "mid";
  metric?: string;
}

/** ORS 채널 4종 (local 은 제외 — 플레이스 등록 boolean 신호로만 사용). */
export type OrsChannel = "blog" | "cafe" | "web" | "news";

export interface OrsChannelResult {
  channel: OrsChannel;
  /** 본 업체 콘텐츠 회수량 */
  count: number;
  /** 경쟁사 중앙값 회수량 */
  competitorMedian: number;
}

export interface CompetitorRow {
  name: string;
  ors: number;
  officialAssets: number;
  recency60d: number;
  channelActivity: number;
  isSelf?: boolean;
}

export interface ContactPageCandidate {
  path: string;
  label: string;
  confidence: number;
}

/** 이메일 검증 단계. mx_ok 에 도달해야 승인 가능. */
export type EmailVerification = "syntax_ok" | "dns_ok" | "mx_ok" | "failed";

export interface EnteredEmail {
  address: string;
  type: "대표" | "마케팅" | "채용" | "기타";
  sourcePath: string;
  verification: EmailVerification;
}

export interface SearchAsset {
  channel: OrsChannel | "youtube" | "place";
  title: string;
  date: string;
  official: boolean;
}

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface ReviewItem {
  id: string;
  rank: number;
  companyName: string;
  industry: Industry;
  regionSido: string;
  regionSigungu: string;
  homepageUrl?: string;
  homepageStatus: OfficialStatus;
  placeRegistered: boolean;
  score: AxisScore;
  scoreRationale: string[];
  weaknesses: Weakness[];
  ors: OrsChannelResult[];
  /** ORS 배점 반영 여부 (R2-02 — shadow feature 면 false) */
  orsScored: boolean;
  competitors: CompetitorRow[];
  /** 유효 경쟁사 2곳 미만이면 false — 격차 축 unavailable, 재정규화 금지 (R11) */
  competitorGapAvailable: boolean;
  activity60d: number;
  activity120d: number;
  lastContentAt?: string;
  searchAssets: SearchAsset[];
  contactPages: ContactPageCandidate[];
  primaryService: string;
  secondaryServices: string[];
  recommendRationale: string;
  email?: EnteredEmail;
  status: ReviewStatus;
  rejectReason?: string;
}

export const REJECT_REASONS = [
  "규모 부적합 (대형·네트워크)",
  "이미 마케팅 활발",
  "휴·폐업 의심",
  "기타 부적합",
] as const;

/** 승인 리드 상태 — 향후 Outreach·Pipeline 모듈이 사용할 8단계. */
export type LeadStatus =
  | "READY"
  | "SENT"
  | "OPENED"
  | "REPLIED"
  | "MEETING"
  | "PROPOSAL"
  | "WON"
  | "LOST";

export const LEAD_STATUS_ORDER: LeadStatus[] = [
  "READY", "SENT", "OPENED", "REPLIED", "MEETING", "PROPOSAL", "WON", "LOST",
];

export interface Lead {
  id: string;
  companyName: string;
  industry: Industry;
  region: string;
  email: string;
  score: number;
  approvedAt: string;
  status: LeadStatus;
}

/** 파이프라인 스테이지 13종 (설계서 §5.3 DAG). */
export type StageStatus = "pending" | "running" | "succeeded" | "partial" | "failed" | "skipped";

export interface RunStage {
  name: string;
  label: string;
  status: StageStatus;
  total: number;
  done: number;
  failed: number;
  finishedAt?: string;
}

export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

export interface FailedJob {
  id: string;
  stage: string;
  company: string;
  error: string;
  attempts: number;
  maxAttempts: number;
}

export interface Run {
  id: string;
  date: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  costKrw: number;
  naverQuotaUsed: number;
  naverQuotaLimit: number;
  stages: RunStage[];
  failedJobs: FailedJob[];
}

export interface KeywordTemplate {
  id: string;
  template: string;
  source: "manual" | "llm";
  approved: boolean;
}

export interface IndustryConfig {
  industry: Industry;
  universeEligible: number;
  todayCandidates: number;
  keywords: KeywordTemplate[];
}

/** 오늘의 퍼널 카운터 (MetricStrip). */
export interface TodayMetrics {
  rawCandidates: number;
  analyzed: number;
  reviewQueue: number;
  approved: number;
  rejected: number;
  finalLeads: number;
  approvalCap: number; // targets.final_max
  costKrw: number;
  naverQuotaPct: number;
}
