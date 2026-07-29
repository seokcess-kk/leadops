import type { RawCandidate } from "@leadops/core";

/**
 * 업체명 정규화와 중복 판정 (설계서 5.3 스테이지 2~3).
 *
 * 중복 제거는 **양방향으로 틀릴 수 있다**:
 *   false merge (다른 업체를 같다고 봄) — 리드 품질이 무너진다. 더 나쁘다.
 *   false split (같은 업체를 다르다고 봄) — 중복 리드가 생긴다.
 *
 * 그래서 사업자번호가 있으면 그것만 쓰고, 없을 때만 이름·지역·전화 조합을 쓴다.
 * 설계서 M5 는 오병합 ≤2% 를 요구한다.
 */

/** 법인격 표기. 같은 업체가 이 표기 유무로 갈리는 것을 막는다. */
const LEGAL_FORMS = [
  "의료법인",
  "재단법인",
  "사단법인",
  "학교법인",
  "사회복지법인",
  "주식회사",
  "유한회사",
  "합자회사",
  "합명회사",
  "농업회사법인",
  "영어조합법인",
];

/** 괄호 안 법인격 약어: (의), (재), (사), (주), (유), (합), (학) */
const BRACKET_LEGAL = /[（(]\s*(?:의|재|사|주|유|합|학|복)\s*[）)]/g;

/**
 * 업체명을 비교 가능한 형태로 만든다.
 *
 * - 법인격 표기 제거
 * - 괄호와 그 내용 중 법인격 약어만 제거 (지점명은 남긴다 — 다른 업체이므로)
 * - 공백·구두점 제거
 * - 전각 → 반각, 소문자화
 */
export function normalizeCompanyName(raw: string): string {
  let s = raw.normalize("NFKC").trim();

  s = s.replace(BRACKET_LEGAL, "");
  for (const form of LEGAL_FORMS) {
    s = s.replaceAll(form, "");
  }

  // 구두점·공백 제거. 한글·영문·숫자만 남긴다.
  s = s.replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, "");

  return s.toLowerCase();
}

/** 숫자만 남긴다. 사업자·법인번호·전화번호 비교용. */
export function digitsOnly(value: string | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** 사업자등록번호는 10자리여야 한다. 아니면 신뢰하지 않는다. */
export function normalizeBizNo(raw: string | undefined): string | undefined {
  const d = digitsOnly(raw);
  return d.length === 10 ? d : undefined;
}

/** 법인등록번호는 13자리. */
export function normalizeCorpNo(raw: string | undefined): string | undefined {
  const d = digitsOnly(raw);
  return d.length === 13 ? d : undefined;
}

/**
 * 전화번호를 비교 가능한 형태로.
 *
 * 국가번호(+82)를 0 으로 바꾸고 숫자만 남긴다.
 */
export function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().replace(/^\+?82[-.\s]?/, "0");
  s = digitsOnly(s);
  if (s.length < 9 || s.length > 11) return undefined;
  return s;
}

export interface DedupeKeyResult {
  key: string;
  /** 무엇을 근거로 만들었는지. 오병합을 사후에 진단할 때 필요하다. */
  basis: "biz_no" | "corp_no" | "name_region_phone" | "name_region" | "source_id";
  /** 이 키를 얼마나 믿을 수 있는지. name_region 만으로 만든 키는 약하다. */
  confidence: "high" | "medium" | "low";
}

/**
 * 중복 판정 키.
 *
 * 우선순위:
 *   1. 사업자등록번호 — 유일하고 안정적이다
 *   2. 법인등록번호 — 가맹본부용
 *   3. 정규화 이름 + 시군구 + 전화
 *   4. 정규화 이름 + 시군구 (전화가 없을 때. 약하다)
 *   5. 소스 식별자 (이름조차 정규화 후 비면 병합하지 않는다)
 *
 * ❗ 4번은 같은 건물에 같은 이름의 다른 업체가 있으면 오병합한다.
 *    그래서 confidence 를 낮게 표시하고, 검수 화면에서 경고할 수 있게 한다.
 */
export function buildDedupeKey(candidate: RawCandidate): DedupeKeyResult {
  const bizNo = normalizeBizNo(candidate.bizNo);
  if (bizNo) return { key: `biz:${bizNo}`, basis: "biz_no", confidence: "high" };

  const corpNo = normalizeCorpNo(candidate.corpNo);
  if (corpNo) return { key: `corp:${corpNo}`, basis: "corp_no", confidence: "high" };

  const name = normalizeCompanyName(candidate.name);
  const region = normalizeCompanyName(candidate.regionSigungu ?? candidate.regionSido ?? "");

  if (name.length === 0) {
    // 이름이 정규화 후 비었다면 병합 근거가 없다. 소스 식별자로 고립시킨다.
    return {
      key: `src:${candidate.source}:${candidate.externalId}`,
      basis: "source_id",
      confidence: "low",
    };
  }

  const phone = normalizePhone(candidate.phone);
  if (phone) {
    return { key: `nrp:${name}|${region}|${phone}`, basis: "name_region_phone", confidence: "medium" };
  }

  return { key: `nr:${name}|${region}`, basis: "name_region", confidence: "low" };
}

/**
 * 그룹 키 (설계서 1.5 — 동일 네트워크·다지점 브랜드를 본원·법인 기준으로 통합).
 *
 * 법인번호가 있으면 그것으로 묶고, 없으면 묶지 않는다.
 * **이름만으로 묶지 않는다** — "연세치과" 는 전국에 수백 개이고 서로 무관하다.
 */
export interface GroupKeyResult {
  key: string;
  kind: "corporation" | "brand" | "network";
  displayName: string;
}

export function buildGroupKey(candidate: RawCandidate): GroupKeyResult | undefined {
  const corpNo = normalizeCorpNo(candidate.corpNo);
  if (corpNo) {
    return { key: `corp:${corpNo}`, kind: "corporation", displayName: candidate.name };
  }
  // 프랜차이즈는 브랜드 관리번호가 곧 브랜드 단위다.
  if (candidate.industry === "franchise") {
    return {
      key: `brand:${candidate.source}:${candidate.externalId}`,
      kind: "brand",
      displayName: candidate.name,
    };
  }
  return undefined;
}

/** 지역 문자열에서 시도를 표준화한다. 소스마다 '서울' / '서울특별시' 로 다르게 온다. */
const SIDO_CANONICAL: ReadonlyArray<[RegExp, string]> = [
  [/^서울/, "서울특별시"],
  [/^부산/, "부산광역시"],
  [/^대구/, "대구광역시"],
  [/^인천/, "인천광역시"],
  [/^광주(?!시)/, "광주광역시"],
  [/^대전/, "대전광역시"],
  [/^울산/, "울산광역시"],
  [/^세종/, "세종특별자치시"],
  [/^경기/, "경기도"],
  [/^강원/, "강원특별자치도"],
  [/^충북|^충청북/, "충청북도"],
  [/^충남|^충청남/, "충청남도"],
  [/^전북|^전라북/, "전북특별자치도"],
  [/^전남|^전라남/, "전라남도"],
  [/^경북|^경상북/, "경상북도"],
  [/^경남|^경상남/, "경상남도"],
  [/^제주/, "제주특별자치도"],
];

export function canonicalSido(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (s.length === 0) return undefined;
  for (const [pattern, canonical] of SIDO_CANONICAL) {
    if (pattern.test(s)) return canonical;
  }
  return s;
}
