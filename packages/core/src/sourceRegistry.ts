import { sourceNotApproved } from "./errors";

/**
 * 소스 레지스트리 (설계서 3.4절 · F-25 · R2-02).
 *
 * 어댑터는 부팅 시 자신의 레지스트리 항목이 승인되었는지 확인하고,
 * 아니면 **실행을 거부**한다. 조용한 폴백은 없다.
 *
 * MVP 단계에서는 코드에 상수로 두고, Phase 1 에서 DB `source_registry` 테이블로 옮긴다.
 * 옮기는 시점에 이 파일의 `SOURCE_REGISTRY` 는 시드 데이터가 된다.
 */
export interface SourceRegistryEntry {
  source: string;
  label: string;
  termsUrl?: string;
  /** 수집 근거. 왜 이 소스를 쓸 수 있는가. */
  legalBasis: string;
  allowedUse: string;
  redistributionAllowed: boolean;
  approved: boolean;
  /** 서면 허용 근거 (메일 ID · 문서번호 · 의사결정 기록 ID). 없으면 ORS 계열은 부팅 거부. */
  writtenApprovalRef?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  note?: string;
}

export const SOURCE_REGISTRY: Readonly<Record<string, SourceRegistryEntry>> = Object.freeze({
  hira_hospital: {
    source: "hira_hospital",
    label: "건강보험심사평가원 병원정보서비스",
    termsUrl: "https://www.data.go.kr/data/15001698/openapi.do",
    legalBasis: "공공데이터법에 따른 공공데이터 개방 · 포털 이용약관 동의",
    allowedUse: "영리·비영리 목적 이용 가능 (출처 표시)",
    redistributionAllowed: true,
    approved: true,
    reviewedAt: "2026-07-29",
  },
  ftc_franchise: {
    source: "ftc_franchise",
    label: "공정거래위원회 가맹정보",
    termsUrl: "https://www.data.go.kr/data/15125467/openapi.do",
    legalBasis: "공공데이터법에 따른 공공데이터 개방",
    allowedUse: "영리·비영리 목적 이용 가능 (출처 표시)",
    redistributionAllowed: true,
    approved: true,
    reviewedAt: "2026-07-29",
  },
  nts_bizstatus: {
    source: "nts_bizstatus",
    label: "국세청 사업자등록 상태조회",
    termsUrl: "https://www.data.go.kr/data/15081808/openapi.do",
    legalBasis: "공공데이터법에 따른 공공데이터 개방",
    allowedUse: "사업자등록 상태 확인 목적",
    redistributionAllowed: false,
    approved: true,
    reviewedAt: "2026-07-29",
  },
  naver_search: {
    source: "naver_search",
    label: "네이버 검색 오픈 API",
    termsUrl: "https://developers.naver.com/products/terms/",
    legalBasis: "네이버 API 이용약관",
    allowedUse: "사내 리드 발굴 분석 (결과 원문 재배포 금지)",
    redistributionAllowed: false,
    // D-002 (docs/03-decisions.md) — 발주자 판단으로 사용 승인.
    // ❗ 약관 조항·API HUB 이관 여부는 Phase -1 확인 항목으로 남아 있음.
    //    문제가 생기면 이 한 행을 approved:false 로 바꾸면 즉시 축소 파이프라인으로 폴백된다.
    approved: true,
    writtenApprovalRef: "D-002",
    reviewedBy: "발주자",
    reviewedAt: "2026-07-29",
    note: "약관 조항 문언 미검증. Phase -1 에서 전문 확인 필요.",
  },
  youtube_data: {
    source: "youtube_data",
    label: "YouTube Data API v3",
    legalBasis: "Google API 서비스 약관",
    // R2-29: search.list 는 호출당 100 units 라 100업체만 조회해도 일 쿼터가 소진된다.
    allowedUse: "channels.list(1 unit) 만 사용. search.list 사용 금지",
    redistributionAllowed: false,
    approved: true,
    reviewedAt: "2026-07-29",
  },
  target_homepage: {
    source: "target_homepage",
    label: "대상 업체 공식 홈페이지 직접 fetch",
    legalBasis: "공개된 웹 페이지 열람 · robots.txt 준수",
    // ❗ 결론 A: 이메일 문자열 추출은 정보통신망법 제50조의2 위반 소지가 있어 하지 않는다.
    allowedUse: "공식 여부 판별 · 연락처 페이지 링크 탐지 · 기술 신호. 이메일 추출 금지",
    redistributionAllowed: false,
    approved: true,
    reviewedAt: "2026-07-29",
  },
} satisfies Record<string, SourceRegistryEntry>);

export type SourceName = keyof typeof SOURCE_REGISTRY;

export function getSourceEntry(source: string): SourceRegistryEntry {
  const entry = SOURCE_REGISTRY[source];
  if (!entry) throw sourceNotApproved(source, "레지스트리에 등록되지 않은 소스입니다");
  return entry;
}

/**
 * 어댑터 부팅 검사.
 *
 * @param requireWrittenApproval 서면 허용 근거까지 요구할지. 네이버처럼 약관 리스크가 있는
 *                               소스는 true 로 호출한다.
 */
export function assertSourceApproved(source: string, requireWrittenApproval = false): SourceRegistryEntry {
  const entry = getSourceEntry(source);
  if (!entry.approved) {
    throw sourceNotApproved(source, "source_registry.approved = false");
  }
  if (requireWrittenApproval && !entry.writtenApprovalRef) {
    throw sourceNotApproved(source, "서면 허용 근거(writtenApprovalRef)가 없습니다");
  }
  return entry;
}
