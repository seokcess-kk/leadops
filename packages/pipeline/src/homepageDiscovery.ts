import { classifyDomain, isDisqualifyingClass } from "./aggregators";

/**
 * 홈페이지 발견 — 지역검색 결과에서 공식 홈페이지 후보를 고른다 (설계서 3.2 · M1 소스 보강).
 *
 * ## 왜 필요한가
 *
 * HIRA 의 `hospUrl` 은 **실측 20.8%** 만 채워져 있다 (표본 900건). 나머지 79% 는 평가할
 * URL 자체가 없어 `homepage_detect` 가 판정하지 못하고, 뒤 단계가 전부 그 위에서만 돈다.
 * M1 기준 ≥70% 는 소스 보강 없이 넘을 수 없다.
 *
 * ## 왜 검색 결과를 그대로 믿지 않는가
 *
 * 이 저장소는 **채널 발견에서 검색을 쓰지 않는다** — "검색으로 찾으면 동명이인·팬페이지를
 * 공식으로 오인하고 쿼터도 쓴다". 홈페이지도 같은 위험이 있다. `강남삼성의원` 으로 검색하면
 * 다른 지역의 동명 의원, 그 의원을 소개한 블로그, 예약 포털이 함께 나온다.
 *
 * 그래서 여기서는 **이미 알고 있는 사실과 대조해 통과한 것만** 채택한다:
 *
 * | 근거 | 판정 |
 * |---|---|
 * | 전화번호 일치 | **채택** — 공공 API 가 준 대표번호와 같으면 그 업체다 |
 * | 상호 + 시군구 동시 일치 | **채택** (약한 근거) — 둘 다 맞아야 한다 |
 * | 그 외 | **거절** — 추측하지 않는다 |
 *
 * 채택한 URL 도 최종 판정이 아니다. 기존 `homepage_detect` 의 다신호 판정(전화 +35 ·
 * `<title>` +30 · 도메인 겹침 +15 …)을 그대로 통과해야 `confirmed`·`likely` 가 된다.
 * 여기는 **후보를 만드는 단계**일 뿐이다.
 *
 * ❗ 애그리게이터·SNS 링크는 애초에 후보가 되지 않는다. 지역검색의 `link` 는 플레이스·
 *    블로그 주소인 경우가 흔하고, 그것을 홈페이지로 저장하면 `homepage_detect` 가
 *    `not_official` 로 되돌리는 데 HTTP 요청을 한 번 더 쓴다 — 요청 전에 자른다.
 */

/** 지역검색 한 건에서 판별에 쓰는 값. */
export interface LocalCandidate {
  readonly title: string;
  readonly link: string;
  readonly telephone?: string | undefined;
  readonly address?: string | undefined;
  readonly roadAddress?: string | undefined;
}

/** 우리가 이미 알고 있는 사실 (공공 API 가 준 값). */
export interface KnownCompany {
  readonly name: string;
  readonly phone?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly regionSigungu?: string | null | undefined;
}

export type DiscoveryBasis = "phone_match" | "name_and_region_match";

/** 거절 사유. 집계해서 "왜 못 찾았는지" 를 운영자에게 보여 준다. */
export type DiscoveryRejection =
  | "no_candidates"
  | "no_link"
  | "disqualifying_domain"
  | "invalid_url"
  | "no_matching_evidence";

export interface DiscoveryResult {
  readonly url?: string | undefined;
  readonly basis?: DiscoveryBasis | undefined;
  readonly rejected?: DiscoveryRejection | undefined;
  /** 검토했으나 채택하지 않은 이유들. 규칙을 고칠 때 근거가 된다. */
  readonly considered: number;
}

/**
 * 전화번호 정규화.
 *
 * ❗ 숫자만 남긴다. HIRA 는 `02-875-1675`, 지역검색은 `02-875-1675` 또는 `0288751675` 로
 *    주고 국번 표기가 서로 다르다. 문자열 그대로 비교하면 같은 번호가 달라 보인다.
 * ❗ 너무 짧은 값은 비교하지 않는다. `1588` 같은 대표번호 조각이 우연히 겹칠 수 있다.
 */
export function normalizePhone(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 ? digits : undefined;
}

/**
 * 상호 정규화.
 *
 * 공백·괄호·법인격 표기를 지운다. `(사)한국건강관리협회 건강치과의원` 과
 * `한국건강관리협회건강치과의원` 은 같은 곳이다.
 */
export function normalizeName(raw: string): string {
  return raw
    .replace(/\([^)]*\)/g, "")
    .replace(/[주식회사|의료법인|사단법인|재단법인]/g, "")
    .replace(/[\s\-_·ㆍ.,'"]/g, "")
    .toLowerCase();
}

/** 호스트를 뽑는다. 파싱 실패는 후보에서 뺀다 — 고칠 수 있는 값이 아니다. */
function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/**
 * 후보 하나가 그 업체의 것인지 판정한다.
 *
 * 반환값이 `undefined` 면 근거가 없다는 뜻이다 — **추측하지 않는다.**
 */
export function evidenceFor(known: KnownCompany, candidate: LocalCandidate): DiscoveryBasis | undefined {
  const ourPhone = normalizePhone(known.phone);
  const theirPhone = normalizePhone(candidate.telephone);
  // ❗ 전화 일치가 가장 강한 근거다. 공공 API 의 대표번호와 같으면 그 업체다.
  if (ourPhone !== undefined && theirPhone !== undefined && ourPhone === theirPhone) {
    return "phone_match";
  }

  // 전화가 없거나 다르면, 상호와 지역이 **둘 다** 맞아야 한다. 하나만으로는 부족하다 —
  // 상호만 맞으면 동명이인이고, 지역만 맞으면 옆 건물 다른 병원이다.
  const ourName = normalizeName(known.name);
  const theirName = normalizeName(candidate.title);
  const nameMatches =
    ourName.length >= 3 && theirName.length >= 3 && (theirName.includes(ourName) || ourName.includes(theirName));
  if (!nameMatches) return undefined;

  const sigungu = (known.regionSigungu ?? "").trim();
  if (sigungu === "") return undefined;
  const theirAddress = `${candidate.address ?? ""} ${candidate.roadAddress ?? ""}`;
  if (!theirAddress.includes(sigungu)) return undefined;

  return "name_and_region_match";
}

/**
 * 지역검색 결과에서 홈페이지 후보를 고른다.
 *
 * ❗ 근거가 있는 것 중 **가장 강한 것**을 고른다 (전화 일치 > 상호+지역). 순위가 높다는
 *    이유로 고르지 않는다 — 검색 순위는 그 업체 것이라는 근거가 아니다.
 */
export function discoverHomepage(
  known: KnownCompany,
  candidates: readonly LocalCandidate[],
): DiscoveryResult {
  if (candidates.length === 0) return { rejected: "no_candidates", considered: 0 };

  let best: { url: string; basis: DiscoveryBasis } | undefined;
  // 마지막으로 본 거절 사유. 무엇 때문에 못 찾았는지 집계에 쓴다.
  let rejection: DiscoveryRejection = "no_matching_evidence";

  for (const candidate of candidates) {
    if (!candidate.link) {
      rejection = "no_link";
      continue;
    }
    const host = hostOf(candidate.link);
    if (host === undefined) {
      rejection = "invalid_url";
      continue;
    }
    // ❗ 요청 전에 자른다. 플레이스·블로그를 홈페이지로 저장하면 판정 단계가 HTTP 를
    //    한 번 더 쓰고 `not_official` 로 되돌린다.
    if (isDisqualifyingClass(classifyDomain(host))) {
      rejection = "disqualifying_domain";
      continue;
    }

    const basis = evidenceFor(known, candidate);
    if (basis === undefined) continue;

    if (basis === "phone_match") {
      // 가장 강한 근거다. 더 볼 필요가 없다.
      return { url: candidate.link, basis, considered: candidates.length };
    }
    best ??= { url: candidate.link, basis };
  }

  if (best) return { url: best.url, basis: best.basis, considered: candidates.length };
  return { rejected: rejection, considered: candidates.length };
}

/**
 * 지역검색에 보낼 질의.
 *
 * ❗ 상호만 보내면 전국의 동명 업체가 섞인다. 시군구를 붙여 후보 자체를 좁힌다 —
 *    쿼터를 아끼는 것이 아니라 **오인 가능성을 줄이는** 것이 목적이다.
 */
export function discoveryQuery(known: KnownCompany): string {
  const sigungu = (known.regionSigungu ?? "").trim();
  return sigungu === "" ? known.name : `${sigungu} ${known.name}`;
}
