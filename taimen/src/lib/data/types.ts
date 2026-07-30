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

/**
 * 취약점 등급.
 *
 * ❗ 값은 백엔드 점수 로직(설계서 부록 A.4)과 **같아야 한다.** UI 가 자기 어휘를 쓰면
 *    API 응답을 옮길 때마다 변환이 끼고, 그 변환이 곧 버그가 된다.
 *    `weak`(기술 SEO)은 단독으로 리드가 되지 않으므로 화면에서도 약하게 표시한다.
 */
export type WeaknessSeverity = "strong" | "medium" | "clear_gap" | "weak";

export interface Weakness {
  kind: string;
  label: string;
  severity: WeaknessSeverity;
  metric?: string;
}

/** 강조 색을 쓸 등급인가. strong·clear_gap 만 눈에 띄게 한다. */
export const isSevere = (s: WeaknessSeverity): boolean => s === "strong" || s === "clear_gap";

/** ORS 채널 4종 (local 은 제외 — 플레이스 등록 boolean 신호로만 사용). */
export type OrsChannel = "blog" | "cafe" | "web" | "news";

export interface OrsChannelResult {
  channel: OrsChannel;
  /** 본 업체 콘텐츠 회수량 */
  count: number;
  /**
   * 경쟁사 중앙값 회수량.
   *
   * ❗ 모를 때 0 이 아니라 `null` 이다. 0 으로 채우면 "경쟁사가 아무것도 안 한다" 로
   *    읽혀 없는 격차를 만들어 낸다 (설계서 A.6 과 같은 원칙).
   */
  competitorMedian: number | null;
}

export interface CompetitorRow {
  name: string;
  /** 유효하지 않은 경쟁사(분석 전)는 지표가 없다. 0 으로 채우지 않는다. */
  isValid: boolean;
  ors: number | null;
  officialAssets: number | null;
  recency60d: number | null;
  channelActivity: number | null;
  isSelf?: boolean;
}

export interface ContactPageCandidate {
  /** `contact_pages.id`. 이메일 입력 시 이 id 를 보낸다 (경로가 아니라 id 다). */
  id: string;
  url: string;
  /** 표시용 경로. `url` 에서 잘라 낸다. */
  path: string;
  label: string;
  confidence: number | null;
}

/** 이메일 검증 단계. mx_ok 에 도달해야 승인 가능. */
export type EmailVerification = "syntax_ok" | "dns_ok" | "mx_ok" | "failed";

/** `email_type` 열거형과 일치한다 (마이그레이션 0001). */
export type EmailType =
  | "representative"
  | "inquiry"
  | "partnership"
  | "marketing"
  | "business_info"
  | "staff"
  | "unknown";

/** 화면에 보여줄 한글 라벨. 저장되는 값은 위 열거형이다. */
export const EMAIL_TYPE_LABEL: Record<EmailType, string> = {
  representative: "대표",
  inquiry: "문의",
  partnership: "제휴",
  marketing: "마케팅",
  business_info: "사업자정보",
  staff: "담당자",
  unknown: "기타",
};

export interface EnteredEmail {
  /** `emails.id`. 승인 요청에 이 id 를 보낸다. */
  id?: string;
  address: string;
  type: EmailType;
  sourcePath: string;
  verification: EmailVerification;
  /** MX 호스트. 없으면 implicit MX(A/AAAA)로 통과한 것이다. */
  mxHosts?: string[];
  implicitMx?: boolean;
  /** 실패 사유. 통과하면 없다. */
  reason?: string;
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
  /**
   * 상세를 불러왔는가.
   *
   * 목록 응답에는 ORS·경쟁사·채널·연락처 페이지가 없다. 이 값이 `false` 인 항목의
   * 빈 배열은 "없음" 이 아니라 **아직 모름**이다 — 드로어는 상세를 받은 뒤 그린다.
   */
  detailLoaded?: boolean;
  /** 검수 화면을 열었다는 1회용 증거. 이메일 입력에 필요하다. */
  nonce?: string;
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
  /**
   * 발송 상태.
   *
   * ⚠️ Outreach 모듈의 것이고 **아직 DB 에 없다.** API 는 이 값을 주지 않으므로
   *    승인된 리드는 전부 `READY` 로 표시된다. 모듈이 생기면 서버 값으로 바꾼다.
   */
  status: LeadStatus;
  contactBasis?: string;
  retentionUntil?: string;
  exportStatus?: string;
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
