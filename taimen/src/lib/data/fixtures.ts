/**
 * ⚠️ 개발용 FIXTURE 데이터.
 *
 * 설계서 §7.2 HTTP API 서버는 아직 구현 전이다 (모노레포 Phase -1).
 * 이 파일은 모노레포의 mock 1급 개발 경로 컨벤션(FEATURE_SOURCE=mock)을 따르는
 * 명시적 개발 모드이며, 실데이터 연동 완료를 의미하지 않는다.
 * API 서버가 생기면 store.tsx 의 데이터 소스만 §7.2 클라이언트로 교체한다.
 * 업체명은 전부 가상이다.
 */

import type {
  IndustryConfig, Lead, ReviewItem, Run, TodayMetrics,
} from "./types";

export const DATA_SOURCE_MODE = "fixture" as const;

export const TODAY = "2026-07-29";

export const todayMetrics: TodayMetrics = {
  rawCandidates: 412,
  analyzed: 100,
  reviewQueue: 37,
  approved: 9,
  rejected: 18,
  finalLeads: 9,
  approvalCap: 50,
  costKrw: 1240,
  naverQuotaPct: 38,
};

const asset = (channel: ReviewItem["searchAssets"][number]["channel"], title: string, date: string, official = false) =>
  ({ channel, title, date, official });

export const reviewItems: ReviewItem[] = [
  {
    id: "rv-001", rank: 1, companyName: "라온피부과의원", industry: "derm",
    regionSido: "서울", regionSigungu: "마포구",
    homepageUrl: "https://raon-derm.example", homepageStatus: "confirmed", placeRegistered: true,
    score: { problem: 52, propensity: 21, confidence: 13, total: 86 },
    scoreRationale: [
      "최근 60일 공식 채널 발행 0건 — 문제 축 만점 구간",
      "홈페이지 confirmed + 플레이스 등록 — 구매 여력 신호 강함",
      "공공 데이터·홈페이지·채널 3원 교차 확인 — 신뢰 상위",
    ],
    weaknesses: [
      { kind: "no_recent_content", label: "최근 60일 발행 0건", severity: "strong", metric: "0건/60일" },
      { kind: "ors_gap", label: "블로그 회수 경쟁 대비 8%", severity: "strong", metric: "3 vs 38" },
      { kind: "channel_single", label: "채널 다양성 1종", severity: "medium" },
    ],
    ors: [
      { channel: "blog", count: 3, competitorMedian: 38 },
      { channel: "cafe", count: 1, competitorMedian: 12 },
      { channel: "web", count: 6, competitorMedian: 21 },
      { channel: "news", count: 0, competitorMedian: 4 },
    ],
    orsScored: false,
    competitors: [
      { name: "라온피부과의원", isValid: true, ors: 0.08, officialAssets: 4, recency60d: 0, channelActivity: 0.6, isSelf: true },
      { name: "M피부과 (합정)", isValid: true, ors: 0.41, officialAssets: 31, recency60d: 18, channelActivity: 3.2 },
      { name: "S클리닉 (홍대)", isValid: true, ors: 0.33, officialAssets: 22, recency60d: 11, channelActivity: 2.4 },
      { name: "더블유의원 (공덕)", isValid: true, ors: 0.18, officialAssets: 12, recency60d: 5, channelActivity: 1.1 },
    ],
    competitorGapAvailable: true,
    activity60d: 0, activity120d: 2, lastContentAt: "2026-03-14",
    searchAssets: [
      asset("blog", "봄맞이 피부 관리 이벤트 안내", "2026-03-14", true),
      asset("cafe", "마포 피부과 후기 공유해요", "2026-05-02"),
      asset("web", "라온피부과의원 진료 안내", "2025-12-20", true),
    ],
    contactPages: [
      { id: "cp-1", url: "https://example.kr/contact", path: "/contact", label: "문의하기", confidence: 0.91 },
      { id: "cp-2", url: "https://example.kr/about", path: "/about", label: "병원소개", confidence: 0.64 },
      { id: "cp-3", url: "https://example.kr/privacy", path: "/privacy", label: "개인정보처리방침", confidence: 0.52 },
    ],
    primaryService: "블로그 콘텐츠 운영 대행",
    secondaryServices: ["플레이스 정보 최적화", "홈페이지 콘텐츠 리뉴얼"],
    recommendRationale: "검색 수요는 있으나 공식 발행이 5개월 중단된 상태. 콘텐츠 운영 재개가 가장 즉효.",
    status: "pending",
  },
  {
    id: "rv-002", rank: 2, companyName: "미소진치과의원", industry: "dental",
    regionSido: "경기", regionSigungu: "성남시 분당구",
    homepageUrl: "https://misojin-dental.example", homepageStatus: "confirmed", placeRegistered: true,
    score: { problem: 48, propensity: 22, confidence: 12, total: 82 },
    scoreRationale: [
      "비브랜드 키워드 콘텐츠 회수 경쟁 중앙값의 14%",
      "신규 장비 도입 보도자료 — 투자 여력 신호",
      "홈페이지·플레이스 정보 일치",
    ],
    weaknesses: [
      { kind: "ors_gap", label: "비브랜드 회수 격차", severity: "strong", metric: "14%" },
      { kind: "no_cafe", label: "카페 언급 0건", severity: "medium" },
    ],
    ors: [
      { channel: "blog", count: 7, competitorMedian: 42 },
      { channel: "cafe", count: 0, competitorMedian: 9 },
      { channel: "web", count: 11, competitorMedian: 26 },
      { channel: "news", count: 2, competitorMedian: 3 },
    ],
    orsScored: false,
    competitors: [
      { name: "미소진치과의원", isValid: true, ors: 0.14, officialAssets: 9, recency60d: 3, channelActivity: 1.0, isSelf: true },
      { name: "B치과 (서현)", isValid: true, ors: 0.44, officialAssets: 27, recency60d: 15, channelActivity: 2.9 },
      { name: "K치과 (정자)", isValid: true, ors: 0.29, officialAssets: 18, recency60d: 9, channelActivity: 2.0 },
      { name: "라임치과 (판교)", isValid: true, ors: 0.21, officialAssets: 14, recency60d: 7, channelActivity: 1.6 },
    ],
    competitorGapAvailable: true,
    activity60d: 3, activity120d: 8, lastContentAt: "2026-07-02",
    searchAssets: [
      asset("blog", "임플란트 식립 과정, 궁금하신가요?", "2026-07-02", true),
      asset("news", "미소진치과, 디지털 스캐너 도입", "2026-06-18"),
      asset("web", "분당 미소진치과 진료시간", "2026-05-11", true),
    ],
    contactPages: [
      { id: "cp-4", url: "https://example.kr/consult", path: "/consult", label: "상담 문의", confidence: 0.88 },
      { id: "cp-5", url: "https://example.kr/about", path: "/about", label: "치과 소개", confidence: 0.61 },
    ],
    primaryService: "비브랜드 검색 콘텐츠 확충",
    secondaryServices: ["카페 커뮤니티 관리", "후기 콘텐츠 기획"],
    recommendRationale: "장비 투자는 하고 있으나 검색 접점이 브랜드 키워드에 편중. 비브랜드 확장 여지가 크다.",
    status: "pending",
    email: { address: "info@misojin-dental.example", type: "representative", sourcePath: "/consult", verification: "mx_ok" },
  },
  {
    id: "rv-003", rank: 3, companyName: "청담라인성형외과", industry: "plastic",
    regionSido: "서울", regionSigungu: "강남구",
    homepageUrl: "https://cdline-ps.example", homepageStatus: "likely", placeRegistered: false,
    score: { problem: 45, propensity: 19, confidence: 10, total: 74 },
    scoreRationale: [
      "플레이스 미등록 — 지역 탐색 접점 부재",
      "홈페이지 공식 여부 likely (도메인 교차 확인 1건)",
      "채널 자산 소수로 신뢰 축 중간",
    ],
    weaknesses: [
      { kind: "no_place", label: "플레이스 미등록", severity: "strong" },
      { kind: "no_recent_content", label: "최근 60일 발행 1건", severity: "medium", metric: "1건/60일" },
    ],
    ors: [
      { channel: "blog", count: 12, competitorMedian: 55 },
      { channel: "cafe", count: 4, competitorMedian: 18 },
      { channel: "web", count: 9, competitorMedian: 30 },
      { channel: "news", count: 1, competitorMedian: 6 },
    ],
    orsScored: false,
    competitors: [
      { name: "청담라인성형외과", isValid: true, ors: 0.11, officialAssets: 15, recency60d: 1, channelActivity: 0.9, isSelf: true },
      { name: "G성형외과 (신사)", isValid: true, ors: 0.38, officialAssets: 44, recency60d: 21, channelActivity: 3.8 },
      { name: "라포레의원 (압구정)", isValid: true, ors: 0.27, officialAssets: 29, recency60d: 12, channelActivity: 2.2 },
    ],
    competitorGapAvailable: true,
    activity60d: 1, activity120d: 5, lastContentAt: "2026-06-20",
    searchAssets: [
      asset("blog", "여름 시즌 상담 안내", "2026-06-20", true),
      asset("cafe", "청담 쪽 상담 다녀온 후기", "2026-04-15"),
    ],
    contactPages: [
      { id: "cp-6", url: "https://example.kr/contact", path: "/contact", label: "오시는 길·문의", confidence: 0.83 },
      { id: "cp-7", url: "https://example.kr/intro", path: "/intro", label: "의료진 소개", confidence: 0.47 },
    ],
    primaryService: "플레이스 신규 등록·세팅",
    secondaryServices: ["블로그 콘텐츠 운영 대행", "지역 키워드 콘텐츠"],
    recommendRationale: "강남권 경쟁 밀집 지역에서 플레이스 부재는 즉시 개선 가능한 최대 공백.",
    status: "pending",
  },
  {
    id: "rv-004", rank: 4, companyName: "본가한상 프랜차이즈", industry: "franchise",
    regionSido: "서울", regionSigungu: "송파구",
    homepageUrl: "https://bonga-hansang.example", homepageStatus: "confirmed", placeRegistered: true,
    score: { problem: 41, propensity: 20, confidence: 13, total: 74 },
    scoreRationale: [
      "가맹 모집 페이지 있으나 검색 회수 극소 — 모집 수요 대비 공백",
      "가맹점 34개 — 성장 구간, 마케팅 예산 개연성",
      "공정위 등록 정보와 홈페이지 일치",
    ],
    weaknesses: [
      { kind: "ors_gap", label: "가맹 키워드 회수 공백", severity: "strong", metric: "2 vs 29" },
      { kind: "no_news", label: "뉴스 언급 없음", severity: "medium" },
    ],
    ors: [
      { channel: "blog", count: 2, competitorMedian: 29 },
      { channel: "cafe", count: 5, competitorMedian: 14 },
      { channel: "web", count: 8, competitorMedian: 19 },
      { channel: "news", count: 0, competitorMedian: 7 },
    ],
    orsScored: false,
    competitors: [
      { name: "본가한상", isValid: true, ors: 0.09, officialAssets: 7, recency60d: 2, channelActivity: 0.8, isSelf: true },
      { name: "H반상 (가맹 61)", isValid: true, ors: 0.35, officialAssets: 25, recency60d: 14, channelActivity: 2.7 },
      { name: "진미푸드 (가맹 48)", isValid: true, ors: 0.31, officialAssets: 20, recency60d: 10, channelActivity: 2.1 },
    ],
    competitorGapAvailable: true,
    activity60d: 2, activity120d: 6, lastContentAt: "2026-07-10",
    searchAssets: [
      asset("blog", "본가한상 신메뉴 출시", "2026-07-10", true),
      asset("cafe", "본가한상 창업 문의드려요", "2026-06-28"),
    ],
    contactPages: [
      { id: "cp-8", url: "https://example.kr/franchise", path: "/franchise", label: "가맹 문의", confidence: 0.93 },
      { id: "cp-9", url: "https://example.kr/company", path: "/company", label: "회사 소개", confidence: 0.58 },
    ],
    primaryService: "가맹 모집 콘텐츠 캠페인",
    secondaryServices: ["뉴스 보도자료 배포", "창업 카페 운영"],
    recommendRationale: "창업 수요 검색은 존재하나 본사 발행 콘텐츠가 비어 있음. 모집 퍼널 상단 공백.",
    status: "pending",
  },
  {
    id: "rv-005", rank: 5, companyName: "수앤미의원", industry: "derm",
    regionSido: "부산", regionSigungu: "해운대구",
    homepageUrl: "https://sunme-clinic.example", homepageStatus: "confirmed", placeRegistered: true,
    score: { problem: 39, propensity: 18, confidence: 12, total: 69 },
    scoreRationale: [
      "채널 다양성 1종 (블로그만) — 확장 여지",
      "플레이스 리뷰 활발 — 수요 신호",
      "교차 확인 2원",
    ],
    weaknesses: [
      { kind: "channel_single", label: "채널 다양성 1종", severity: "strong" },
      { kind: "ors_gap", label: "웹문서 회수 격차", severity: "medium", metric: "5 vs 17" },
    ],
    ors: [
      { channel: "blog", count: 15, competitorMedian: 33 },
      { channel: "cafe", count: 2, competitorMedian: 8 },
      { channel: "web", count: 5, competitorMedian: 17 },
      { channel: "news", count: 0, competitorMedian: 2 },
    ],
    orsScored: false,
    competitors: [
      { name: "수앤미의원", isValid: true, ors: 0.17, officialAssets: 16, recency60d: 6, channelActivity: 1.2, isSelf: true },
      { name: "오션스킨의원", isValid: true, ors: 0.36, officialAssets: 27, recency60d: 13, channelActivity: 2.5 },
      { name: "센텀더마", isValid: true, ors: 0.24, officialAssets: 19, recency60d: 8, channelActivity: 1.8 },
    ],
    competitorGapAvailable: true,
    activity60d: 6, activity120d: 14, lastContentAt: "2026-07-21",
    searchAssets: [
      asset("blog", "여름철 색소 관리 가이드", "2026-07-21", true),
      asset("blog", "휴가철 예약 안내", "2026-07-05", true),
    ],
    contactPages: [
      { id: "cp-10", url: "https://example.kr/contact", path: "/contact", label: "문의", confidence: 0.86 },
    ],
    primaryService: "채널 다각화 (카페·웹문서)",
    secondaryServices: ["블로그 상위 콘텐츠 보강"],
    recommendRationale: "블로그 단일 채널 의존. 카페·웹문서 확장 시 회수 총량 상승 여지.",
    status: "pending",
  },
  {
    id: "rv-006", rank: 6, companyName: "화이트리버치과", industry: "dental",
    regionSido: "대구", regionSigungu: "수성구",
    homepageStatus: "uncertain", placeRegistered: true,
    score: { problem: 44, propensity: 14, confidence: 8, total: 66 },
    scoreRationale: [
      "홈페이지 공식 여부 uncertain — 신뢰 축 하향",
      "발행 공백 4개월",
      "플레이스만 활성",
    ],
    weaknesses: [
      { kind: "no_homepage", label: "홈페이지 확인 불가", severity: "strong" },
      { kind: "no_recent_content", label: "최근 60일 발행 0건", severity: "strong", metric: "0건/60일" },
    ],
    ors: [
      { channel: "blog", count: 4, competitorMedian: 27 },
      { channel: "cafe", count: 1, competitorMedian: 11 },
      { channel: "web", count: 3, competitorMedian: 15 },
      { channel: "news", count: 0, competitorMedian: 2 },
    ],
    orsScored: false,
    competitors: [
      { name: "화이트리버치과", isValid: true, ors: 0.1, officialAssets: 5, recency60d: 0, channelActivity: 0.4, isSelf: true },
      { name: "수성탑치과", isValid: true, ors: 0.4, officialAssets: 24, recency60d: 12, channelActivity: 2.6 },
    ],
    competitorGapAvailable: false,
    activity60d: 0, activity120d: 3, lastContentAt: "2026-03-28",
    searchAssets: [
      asset("place", "화이트리버치과 (플레이스)", "2026-07-15"),
      asset("blog", "3월 진료 일정 안내", "2026-03-28", true),
    ],
    contactPages: [
      { id: "cp-11", url: "https://example.kr/board/notice", path: "/board/notice", label: "공지사항", confidence: 0.41 },
    ],
    primaryService: "홈페이지 신규 구축",
    secondaryServices: ["블로그 개설·운영"],
    recommendRationale: "공식 웹 자산 부재가 근본 문제. 구축 후 콘텐츠 운영 제안이 자연스러운 순서.",
    status: "pending",
  },
  {
    id: "rv-007", rank: 7, companyName: "동네닭집 프랜차이즈", industry: "franchise",
    regionSido: "인천", regionSigungu: "연수구",
    homepageUrl: "https://dongne-chicken.example", homepageStatus: "confirmed", placeRegistered: false,
    score: { problem: 37, propensity: 17, confidence: 11, total: 65 },
    scoreRationale: [
      "가맹점 21개 — 초기 확장 구간",
      "본사 채널 활동 미약",
      "공정위 정보 등록 일치",
    ],
    weaknesses: [
      { kind: "channel_inactive", label: "본사 채널 비활성", severity: "strong" },
      { kind: "no_place", label: "본사 플레이스 미등록", severity: "medium" },
    ],
    ors: [
      { channel: "blog", count: 6, competitorMedian: 24 },
      { channel: "cafe", count: 9, competitorMedian: 16 },
      { channel: "web", count: 4, competitorMedian: 13 },
      { channel: "news", count: 1, competitorMedian: 5 },
    ],
    orsScored: false,
    competitors: [
      { name: "동네닭집", isValid: true, ors: 0.13, officialAssets: 8, recency60d: 2, channelActivity: 0.7, isSelf: true },
      { name: "치킨훠궈 (가맹 55)", isValid: true, ors: 0.3, officialAssets: 21, recency60d: 11, channelActivity: 2.3 },
      { name: "바삭공방 (가맹 39)", isValid: true, ors: 0.26, officialAssets: 17, recency60d: 9, channelActivity: 1.9 },
    ],
    competitorGapAvailable: true,
    activity60d: 2, activity120d: 7, lastContentAt: "2026-07-08",
    searchAssets: [
      asset("cafe", "동네닭집 가맹 조건 아시는 분?", "2026-07-08"),
      asset("blog", "동네닭집 여름 신메뉴", "2026-06-30", true),
    ],
    contactPages: [
      { id: "cp-12", url: "https://example.kr/partner", path: "/partner", label: "가맹 안내", confidence: 0.89 },
    ],
    primaryService: "본사 공식 채널 운영 대행",
    secondaryServices: ["가맹 모집 콘텐츠"],
    recommendRationale: "가맹 문의는 커뮤니티에서 자생 중이나 본사 발신이 없음. 공식 채널 개설이 우선.",
    status: "pending",
  },
  {
    id: "rv-008", rank: 8, companyName: "리즈온의원", industry: "plastic",
    regionSido: "서울", regionSigungu: "서초구",
    homepageUrl: "https://lieson.example", homepageStatus: "confirmed", placeRegistered: true,
    score: { problem: 34, propensity: 16, confidence: 12, total: 62 },
    scoreRationale: [
      "회수량은 중위권이나 최근 활동 급감",
      "상담 페이지 정비 상태 양호",
      "3원 교차 확인",
    ],
    weaknesses: [
      { kind: "activity_drop", label: "최근 60일 발행 급감", severity: "medium", metric: "12→2건" },
    ],
    ors: [
      { channel: "blog", count: 19, competitorMedian: 47 },
      { channel: "cafe", count: 6, competitorMedian: 15 },
      { channel: "web", count: 13, competitorMedian: 24 },
      { channel: "news", count: 2, competitorMedian: 5 },
    ],
    orsScored: false,
    competitors: [
      { name: "리즈온의원", isValid: true, ors: 0.19, officialAssets: 21, recency60d: 2, channelActivity: 1.4, isSelf: true },
      { name: "V라인의원 (교대)", isValid: true, ors: 0.33, officialAssets: 30, recency60d: 14, channelActivity: 2.8 },
      { name: "미엘클리닉 (방배)", isValid: true, ors: 0.25, officialAssets: 23, recency60d: 10, channelActivity: 2.0 },
    ],
    competitorGapAvailable: true,
    activity60d: 2, activity120d: 14, lastContentAt: "2026-07-18",
    searchAssets: [
      asset("blog", "리프팅 시술 전후 관리", "2026-07-18", true),
      asset("web", "리즈온의원 오시는 길", "2026-05-30", true),
    ],
    contactPages: [
      { id: "cp-13", url: "https://example.kr/reservation", path: "/reservation", label: "상담 예약", confidence: 0.9 },
      { id: "cp-14", url: "https://example.kr/about", path: "/about", label: "병원 소개", confidence: 0.6 },
    ],
    primaryService: "콘텐츠 발행 정례화 운영",
    secondaryServices: ["기존 콘텐츠 리프레시"],
    recommendRationale: "운영 역량은 있었으나 최근 중단됨 — 재계약·운영 대행 제안 적기.",
    status: "pending",
  },
];

export const leads: Lead[] = [
  { id: "ld-001", companyName: "그린힐피부과", industry: "derm", region: "서울 은평구", email: "hello@greenhill.example", score: 84, approvedAt: "2026-07-28", status: "REPLIED" },
  { id: "ld-002", companyName: "바른플란트치과", industry: "dental", region: "경기 수원시", email: "cs@barunplant.example", score: 81, approvedAt: "2026-07-28", status: "SENT" },
  { id: "ld-003", companyName: "제이라인의원", industry: "plastic", region: "서울 강남구", email: "info@jline.example", score: 79, approvedAt: "2026-07-27", status: "OPENED" },
  { id: "ld-004", companyName: "밥상마루 본사", industry: "franchise", region: "서울 강서구", email: "fc@bobsangmaru.example", score: 77, approvedAt: "2026-07-27", status: "MEETING" },
  { id: "ld-005", companyName: "라플피부과", industry: "derm", region: "대전 서구", email: "contact@lapl.example", score: 75, approvedAt: "2026-07-24", status: "WON" },
  { id: "ld-006", companyName: "스마일온치과", industry: "dental", region: "서울 노원구", email: "smile@smileon.example", score: 72, approvedAt: "2026-07-24", status: "LOST" },
  { id: "ld-007", companyName: "카페브릭 본사", industry: "franchise", region: "경기 고양시", email: "biz@cafebrick.example", score: 71, approvedAt: "2026-07-23", status: "PROPOSAL" },
  { id: "ld-008", companyName: "윤슬의원", industry: "plastic", region: "부산 진구", email: "front@yunseul.example", score: 70, approvedAt: "2026-07-22", status: "READY" },
];

const stageDefs: [string, string][] = [
  ["collect", "수집"],
  ["normalize", "정규화"],
  ["group", "그룹핑"],
  ["exclude_basic", "기본 제외"],
  ["homepage_detect", "홈페이지 판별"],
  ["contact_pages", "연락처 페이지"],
  ["channel_analyze", "채널 분석"],
  ["search_analyze", "검색 분석"],
  ["competitor_select", "경쟁사 선정"],
  ["competitor_analyze", "경쟁사 분석"],
  ["score", "점수 산정"],
  ["recommend", "추천 생성"],
  ["shortlist", "후보 확정"],
];

const mkStages = (
  counts: [number, number, number][],
  times: string[],
): Run["stages"] =>
  stageDefs.map(([name, label], i) => {
    const [total, done, failed] = counts[i];
    const status =
      failed === 0 && done === total ? "succeeded"
      : done + failed === total && done >= total * 0.8 ? "partial"
      : done + failed === total ? "failed"
      : "running";
    return { name, label, status, total, done, failed, finishedAt: times[i] };
  });

export const runs: Run[] = [
  {
    id: "run-0729", date: "2026-07-29", status: "partial",
    startedAt: "06:00:04", finishedAt: "07:42:19",
    costKrw: 1240, naverQuotaUsed: 9500, naverQuotaLimit: 25000,
    stages: mkStages(
      [
        [412, 412, 0], [412, 409, 3], [409, 409, 0], [409, 409, 0],
        [187, 179, 8], [163, 158, 5], [179, 176, 3], [179, 168, 11],
        [179, 175, 4], [498, 461, 37], [168, 168, 0], [168, 168, 0], [1, 1, 0],
      ],
      ["06:04", "06:09", "06:11", "06:14", "06:31", "06:40", "06:58", "07:21", "07:24", "07:36", "07:39", "07:41", "07:42"],
    ),
    failedJobs: [
      { id: "job-8817", stage: "search_analyze", company: "라플란트치과", error: "NAVER_API_TIMEOUT (blog) — 3회 재시도 소진", attempts: 3, maxAttempts: 3 },
      { id: "job-8823", stage: "competitor_analyze", company: "미담성형외과", error: "COMPETITOR_HOMEPAGE_UNREACHABLE — DNS NXDOMAIN", attempts: 2, maxAttempts: 3 },
      { id: "job-8831", stage: "homepage_detect", company: "굿모닝치과", error: "ROBOTS_DISALLOW — fail-closed 정책으로 skip", attempts: 1, maxAttempts: 1 },
    ],
  },
  {
    id: "run-0728", date: "2026-07-28", status: "succeeded",
    startedAt: "06:00:02", finishedAt: "07:28:44",
    costKrw: 1180, naverQuotaUsed: 8900, naverQuotaLimit: 25000,
    stages: mkStages(
      [
        [398, 398, 0], [398, 398, 0], [398, 398, 0], [398, 398, 0],
        [181, 181, 0], [162, 162, 0], [181, 181, 0], [181, 181, 0],
        [181, 181, 0], [512, 512, 0], [178, 178, 0], [178, 178, 0], [1, 1, 0],
      ],
      ["06:04", "06:08", "06:10", "06:13", "06:29", "06:37", "06:52", "07:12", "07:15", "07:24", "07:26", "07:27", "07:28"],
    ),
    failedJobs: [],
  },
  {
    id: "run-0727", date: "2026-07-27", status: "succeeded",
    startedAt: "06:00:03", finishedAt: "07:31:56",
    costKrw: 1210, naverQuotaUsed: 9100, naverQuotaLimit: 25000,
    stages: mkStages(
      [
        [405, 405, 0], [405, 404, 1], [404, 404, 0], [404, 404, 0],
        [176, 176, 0], [155, 155, 0], [176, 176, 0], [176, 176, 0],
        [176, 176, 0], [489, 489, 0], [172, 172, 0], [172, 172, 0], [1, 1, 0],
      ],
      ["06:04", "06:09", "06:11", "06:14", "06:30", "06:39", "06:55", "07:16", "07:19", "07:27", "07:29", "07:30", "07:31"],
    ),
    failedJobs: [],
  },
];

export const industries: IndustryConfig[] = [
  {
    industry: "derm", universeEligible: 1840, todayCandidates: 118,
    keywords: [
      { id: "kw-d1", template: "{지역} 피부과 추천", source: "manual", approved: true },
      { id: "kw-d2", template: "{지역} {진료과목} 잘하는 곳", source: "manual", approved: true },
      { id: "kw-d3", template: "{지역} 여드름 흉터 치료", source: "llm", approved: false },
    ],
  },
  {
    industry: "plastic", universeEligible: 960, todayCandidates: 74,
    keywords: [
      { id: "kw-p1", template: "{지역} 성형외과 상담", source: "manual", approved: true },
      { id: "kw-p2", template: "{지역} 리프팅 가격", source: "llm", approved: false },
    ],
  },
  {
    industry: "dental", universeEligible: 2310, todayCandidates: 132,
    keywords: [
      { id: "kw-t1", template: "{지역} 치과 추천", source: "manual", approved: true },
      { id: "kw-t2", template: "{지역} 임플란트 잘하는 곳", source: "manual", approved: true },
    ],
  },
  {
    industry: "franchise", universeEligible: 1120, todayCandidates: 88,
    keywords: [
      { id: "kw-f1", template: "{업체명} 가맹 조건", source: "manual", approved: true },
      { id: "kw-f2", template: "{업체명} 창업 비용", source: "llm", approved: false },
    ],
  },
];
