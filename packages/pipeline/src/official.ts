import type { OfficialStatus } from "@leadops/core";
import { classifyDomain, isDisqualifyingClass, SHARED_DOMAIN_LIMIT, type DomainClass } from "./aggregators";
import type { ContactCandidate } from "./contactPages";
import { phoneAppears, type PageScan } from "./html";
import { normalizeCompanyName } from "./normalize";

/**
 * 공식 홈페이지 다신호 판정 (설계서 Phase 3 · R10).
 *
 * 한 신호로 결정하지 않는다. HIRA 의 `hospUrl` 이 그 업체의 것이라는 보장이 없고
 * (플레이스·블로그 주소가 들어오기도 한다), 도메인 이름만으로는 한글 상호를 맞출 수 없다.
 * 그래서 **이미 알고 있는 사실과의 대조**를 합산한다: 전화번호, 상호, 지역.
 *
 * 상태 의미를 분명히 한다:
 *  - `not_official` 은 "그 업체 것이 **아니라는 증거**가 있다" (애그리게이터·SNS·공유 도메인)
 *  - `uncertain`    은 "증거가 없다" — 없음과 아님을 섞지 않는다
 *  - `unavailable`  은 "확인 자체를 못 했다" (URL 없음·robots 차단·fetch 실패)
 *
 * 최종 리드는 `confirmed` 또는 `likely` 만 될 수 있다.
 */

/**
 * 신호 가중치.
 *
 * ❗ 이 숫자들은 골드셋 검증 전의 **초기값**이다. 설계서 M2(정밀도 ≥ 0.90 /
 *    재현율 ≥ 0.75)를 표본으로 측정한 뒤 조정한다. 근거 없이 고치지 말 것.
 */
export const WEIGHTS = {
  /** 가장 강한 신호. 공공 API 로 받은 대표번호가 그 페이지에 그대로 있다. */
  phoneMatch: 35,
  /** `<title>` · `og:site_name` 에 상호가 있다. */
  nameInTitle: 30,
  /** 도메인 레이블이 상호와 겹친다. 한글 상호에서는 거의 발화하지 않으므로 낮다. */
  nameInDomain: 15,
  /** 시군구가 본문에 있다. 지역 업종에서만 의미가 있어 낮게 둔다. */
  regionMatch: 10,
  /** 임대형 빌더가 아닌 자체 도메인. */
  ownDomain: 10,
  /** 연락처·소개 페이지 링크가 실제로 있다 — 살아 있는 사이트라는 방증. */
  contactRoute: 5,
  https: 3,
  /** 임대형 빌더 감점. 배제가 아니라 신뢰도 하향이다. */
  builder: -10,
  /** 껍데기·주차 도메인 감점. */
  shell: -20,
} as const;

/**
 * 껍데기(주차 도메인·"준비중") 판정 기준.
 *
 * ❗ 텍스트 길이만으로 판정하면 **멀쩡한 사이트가 대량으로 감점된다.** 국내 병원
 *    홈페이지는 본문 대부분을 이미지로 넣는 경우가 흔해서, 실제로 운영 중인 사이트도
 *    추출 텍스트가 100자 남짓인 일이 많다. 그래서 "텍스트가 거의 없다" 와
 *    "링크도 거의 없다" 를 **함께** 요구한다. 진짜 껍데기는 내비게이션도 없다.
 */
export const SHELL_TEXT_LENGTH = 80;
export const SHELL_LINK_COUNT = 5;

export const CONFIRMED_MIN = 65;
export const LIKELY_MIN = 40;

export interface OfficialInput {
  readonly companyName: string;
  /** `canonicalizeUrl` 을 통과한 도메인. */
  readonly domain: string;
  /** redirect 를 따라간 최종 URL. 분류는 이 URL 기준으로 한다. */
  readonly finalUrl: string;
  readonly httpStatus: number;
  readonly phone?: string | null | undefined;
  readonly regionSigungu?: string | null | undefined;
  /** 같은 도메인에 묶인 **다른** 업체 수. 목록에 없는 애그리게이터를 잡는 안전망. */
  readonly sharedCompanyCount: number;
  readonly scan: PageScan;
  readonly contactCandidates: readonly ContactCandidate[];
}

export interface OfficialVerdict {
  readonly status: OfficialStatus;
  readonly score: number;
  readonly domainClass: DomainClass;
  /** `website_observations.signals` 에 그대로 저장한다. 판정 근거를 사후에 재구성하기 위해서다. */
  readonly signals: Record<string, number | boolean | string>;
  /** 문의 폼 외에 연락 수단이 보이지 않는다 (설계서: 문의 폼만 있는 업체는 제외). */
  readonly hasContactFormOnly: boolean;
}

/** 확인 자체를 못 한 경우. 점수를 매기지 않는다. */
export function unavailableVerdict(reason: string, domain = ""): OfficialVerdict {
  return {
    status: "unavailable",
    score: 0,
    domainClass: domain ? classifyDomain(domain) : "own",
    signals: { reason },
    hasContactFormOnly: false,
  };
}

/** 도메인 첫 레이블에서 영숫자만 남긴다. `raon-derm.co.kr` → `raonderm` */
function domainLabel(domain: string): string {
  const first = domain.toLowerCase().replace(/^www\./, "").split(".")[0] ?? "";
  return first.replace(/[^a-z0-9]/g, "");
}

/**
 * 타이틀 대조용 상호 변형.
 *
 * 신고명은 의료법 종별 접미(…의원·…병원)를 강제하지만 `<title>` 은 접미 없이 상호만
 * 쓰는 경우가 흔하다 ("기장필피부과의원" 의 타이틀이 "기장필피부과"). 접미를 뗀 변형을
 * 함께 대조하되:
 *  - "한의원" 은 통째로만 뗀다 — "의원" 만 떼면 "행복한의원" → "행복한" 처럼 상호가
 *    아닌 수식어가 남아 아무 타이틀에나 맞는다
 *  - 뗀 나머지가 세 글자 미만이면 우연 일치가 잦아 변형을 쓰지 않는다
 *
 * homepageDiscovery 의 웹검색 폴백도 같은 완화 규칙을 쓴다.
 */
export function titleNeedles(normalized: string): string[] {
  const stripped = normalized.endsWith("한의원")
    ? normalized.slice(0, -"한의원".length)
    : normalized.replace(/(?:의원|병원)$/, "");
  if (stripped === normalized || stripped.length < 3) return [normalized];
  return [normalized, stripped];
}

export function judgeOfficial(input: OfficialInput): OfficialVerdict {
  const { scan, companyName } = input;
  const domainClass = classifyDomain(new URL(input.finalUrl).hostname);

  const contactRoutes = input.contactCandidates.filter((c) => c.pageKind !== "terms");
  const hasContactFormOnly = scan.formCount > 0 && contactRoutes.length === 0;

  // ── 즉시 탈락: 그 업체 것이 아니라는 증거 ──
  if (isDisqualifyingClass(domainClass)) {
    return {
      status: "not_official",
      score: 0,
      domainClass,
      signals: { disqualified: domainClass, finalHost: new URL(input.finalUrl).hostname },
      hasContactFormOnly,
    };
  }
  if (input.sharedCompanyCount >= SHARED_DOMAIN_LIMIT) {
    return {
      status: "not_official",
      score: 0,
      domainClass,
      signals: { disqualified: "shared_domain", sharedCompanyCount: input.sharedCompanyCount },
      hasContactFormOnly,
    };
  }

  // ── 신호 합산 ──
  const normalized = normalizeCompanyName(companyName);
  const titleHay = normalizeCompanyName(
    [scan.title, scan.siteName, scan.description].filter(Boolean).join(" "),
  );
  // 두 글자 상호는 우연히 맞을 수 있어 신호로 쓰지 않는다.
  const nameInTitle =
    normalized.length >= 3 && titleNeedles(normalized).some((needle) => titleHay.includes(needle));

  const label = domainLabel(input.domain);
  const nameInDomain = label.length >= 4 && (normalized.includes(label) || label.includes(normalized));

  const phoneMatch = phoneAppears(scan, input.phone);
  const regionMatch = Boolean(input.regionSigungu) && scan.contains(input.regionSigungu!);
  const isShell = scan.textLength < SHELL_TEXT_LENGTH && scan.linkCount < SHELL_LINK_COUNT;
  const https = input.finalUrl.startsWith("https://");

  const parts: Array<[string, number]> = [];
  const add = (key: keyof typeof WEIGHTS, on: boolean): void => {
    if (on) parts.push([key, WEIGHTS[key]]);
  };

  add("phoneMatch", phoneMatch);
  add("nameInTitle", nameInTitle);
  add("nameInDomain", nameInDomain);
  add("regionMatch", regionMatch);
  add("ownDomain", domainClass === "own");
  add("contactRoute", contactRoutes.length > 0);
  add("https", https);
  add("builder", domainClass === "builder");
  add("shell", isShell);

  const score = parts.reduce((sum, [, v]) => sum + v, 0);

  const status: OfficialStatus =
    score >= CONFIRMED_MIN ? "confirmed" : score >= LIKELY_MIN ? "likely" : "uncertain";

  return {
    status,
    score,
    domainClass,
    signals: {
      score,
      phoneMatch,
      nameInTitle,
      nameInDomain,
      regionMatch,
      domainClass,
      isShell,
      https,
      httpStatus: input.httpStatus,
      hasNoindex: scan.hasNoindex,
      formCount: scan.formCount,
      linkCount: scan.linkCount,
      textLength: scan.textLength,
      contactCandidates: input.contactCandidates.length,
      sharedCompanyCount: input.sharedCompanyCount,
      applied: parts.map(([k, v]) => `${k}:${v > 0 ? "+" : ""}${v}`).join(" "),
    },
    hasContactFormOnly,
  };
}
