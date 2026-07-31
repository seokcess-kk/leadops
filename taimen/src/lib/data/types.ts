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
  /** DB `channel_type` 어휘 그대로 (표시 전용 — 변환 계층을 두지 않는다). */
  channel: string;
  title: string;
  /** 발행일 (YYYY-MM-DD). 발행일을 모르면 빈 문자열 — 수집일로 대체하지 않는다. */
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

/** 파이프라인 스테이지 상태. `stage_status` 열거형과 같다 (마이그레이션 0001). */
export type StageStatus = "pending" | "running" | "succeeded" | "partial" | "failed" | "skipped";

/**
 * 파이프라인 스테이지 12종의 한글 라벨 (설계서 §5.3 DAG).
 *
 * ❗ API 는 `run_stages.stage` 를 열거형 값 그대로 준다 — 라벨을 주지 않는다. 여기가 유일한
 *    번역 지점이고, 키는 `apps/api/src/routes/runs.ts` 의 `STAGES` 와 같아야 한다.
 */
export const STAGE_LABEL: Record<string, string> = {
  collect: "수집",
  normalize: "정규화 · 중복 제거",
  exclude_basic: "기본 제외",
  homepage_detect: "공식 홈페이지 판정",
  contact_pages: "연락처 페이지 탐지",
  channel_analyze: "채널 활성도",
  search_analyze: "검색 회수 점유 (ORS)",
  competitor_select: "경쟁사 선정",
  competitor_analyze: "경쟁사 지표",
  score: "3축 점수 · 게이트",
  recommend: "추천 서비스",
  shortlist: "검수 후보 확정",
};

/** 서버가 모르는 스테이지를 보내와도 화면이 비지 않게 한다. */
export const stageLabel = (stage: string): string => STAGE_LABEL[stage] ?? stage;

/**
 * DAG 순서. `STAGE_LABEL` 의 선언 순서가 곧 파이프라인 순서다.
 *
 * ❗ API 는 `order by s.stage` 로 **알파벳 순**을 준다 (`routes/runs.ts`). 그대로 그리면
 *    `channel_analyze` 가 `collect` 보다 앞에 와서 "채널 분석이 먼저 돌았다" 로 읽힌다.
 *    순서를 아는 곳은 여기뿐이므로 화면에서 정렬한다.
 */
const STAGE_ORDER: readonly string[] = Object.keys(STAGE_LABEL);

/** 모르는 스테이지는 뒤로 보낸다 — 빠뜨리지 않고, 알려진 순서를 흐트러뜨리지도 않는다. */
export const stageRank = (stage: string): number => {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? STAGE_ORDER.length : index;
};

/** 서버 문자열을 StageStatus 로 좁힌다. 열거형이 늘어나면 원문을 그대로 두는 대신 pending 으로 본다. */
const STAGE_STATUSES: readonly StageStatus[] = [
  "pending", "running", "succeeded", "partial", "failed", "skipped",
];
export const asStageStatus = (value: string): StageStatus =>
  (STAGE_STATUSES as readonly string[]).includes(value) ? (value as StageStatus) : "pending";

export interface RunStage {
  name: string;
  label: string;
  status: StageStatus;
  total: number;
  done: number;
  failed: number;
  finishedAt?: string;
}

/** `run_status` 열거형과 같다 (마이그레이션 0001). `paused` 를 빠뜨리면 화면이 빈 태그를 그린다. */
export type RunStatus =
  | "queued" | "running" | "paused" | "succeeded" | "partial" | "failed" | "cancelled";

/** 실행 상태를 스테이지 태그 어휘로 옮긴다. StageTag 하나로 두 상태를 다 그리기 위한 것이다. */
export const RUN_STATUS_AS_STAGE: Record<RunStatus, StageStatus> = {
  queued: "pending",
  running: "running",
  paused: "pending",
  succeeded: "succeeded",
  partial: "partial",
  failed: "failed",
  cancelled: "skipped",
};

export const asRunStatus = (value: string): RunStatus =>
  value in RUN_STATUS_AS_STAGE ? (value as RunStatus) : "queued";

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

/**
 * 오늘의 퍼널 카운터 (MetricStrip).
 *
 * ❗ `null` 은 **모른다**는 뜻이고 0 과 다르다 (설계서 A.6). 화면은 `null` 을 `—` 로 그린다.
 *    0 으로 채우면 "수집한 것이 없다" 로 읽혀 운영자가 실행이 실패한 것으로 오해한다.
 *
 *  - `rawCandidates`·`analyzed` — 오늘 run 의 `runs.counts` 스냅샷. 오늘 실행이 없거나
 *    구버전 실행(빈 counts)이면 `null` 이다.
 *  - `rejected` — `/api/review?status=rejected` 목록의 `decided_at` 오늘(KST)분.
 *    목록 limit(200)를 넘는 날은 하한값이다 — 일 상한 50 체제에서 현실적으로 없다.
 *  - `costKrw`·`naverQuotaPct` — `/api/costs` 가 admin 전용이다. 검수자 권한이면 `null`.
 */
export interface TodayMetrics {
  rawCandidates: number | null;
  analyzed: number | null;
  reviewQueue: number;
  approved: number;
  rejected: number | null;
  finalLeads: number;
  approvalCap: number | null; // targets.final_max
  costKrw: number | null;
  naverQuotaPct: number | null;
}
