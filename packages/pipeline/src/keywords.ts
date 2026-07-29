import type { Industry } from "@leadops/core";
import { normalizeCompanyName } from "./normalize";

/**
 * 업종별 검색 키워드 생성 (설계서 4.1 · 8.2).
 *
 * 규칙 기반 템플릿이 1급 경로다. 언어 모델은 초안을 제안할 뿐이고, 그 초안은
 * `company_keywords.approved = false` 로 들어가 승인 전까지 검색에 쓰이지 않는다
 * (설계서 비용 원칙: 언어 모델 없이도 핵심 기능이 동작해야 한다).
 *
 * 쿼터 예산(설계서 4.1)이 **업체당 대표 키워드 3개**를 전제하므로 기본 생성량을
 * 그에 맞춘다. 늘리면 일 호출이 선형으로 늘어난다.
 */

export type KeywordKind = "brand" | "nonbrand_core" | "nonbrand_long";

export interface GeneratedKeyword {
  readonly keyword: string;
  readonly kind: KeywordKind;
  /** 낮을수록 먼저 쓴다. */
  readonly priority: number;
  readonly source: "template";
}

/** 업종의 일반명. 비브랜드 키워드의 뼈대가 된다. */
const INDUSTRY_TERM: Record<Industry, string> = {
  derm: "피부과",
  plastic: "성형외과",
  dental: "치과",
  franchise: "프랜차이즈",
};

/** 업종별 대표 시술·주제. 롱테일 키워드에 쓴다. */
const INDUSTRY_TOPICS: Record<Industry, readonly string[]> = {
  derm: ["여드름", "기미", "리프팅", "제모"],
  plastic: ["눈성형", "코성형", "안면윤곽", "지방흡입"],
  dental: ["임플란트", "치아교정", "충치치료", "스케일링"],
  franchise: ["창업비용", "가맹문의", "가맹점 모집", "창업설명회"],
};

/**
 * 지역명을 검색어에 쓰기 좋게 다듬는다.
 *
 * `강남구` → `강남`, `수원시 영통구` → `영통`. 행정 접미사를 그대로 붙이면
 * 사람들이 실제로 검색하는 형태와 멀어진다.
 */
export function searchRegion(sigungu: string | null | undefined): string | undefined {
  if (!sigungu) return undefined;
  const last = sigungu.trim().split(/\s+/).pop();
  if (!last) return undefined;
  const trimmed = last.replace(/(특별시|광역시|자치시|자치도|[시군구])$/u, "");
  // `중구` → `중` 처럼 한 글자만 남으면 원형이 낫다.
  return trimmed.length >= 2 ? trimmed : last;
}

export interface KeywordInput {
  readonly name: string;
  readonly industry: Industry;
  readonly regionSigungu?: string | null | undefined;
}

/**
 * 업체 하나의 키워드를 만든다.
 *
 * - `brand` — 상호. ORS 를 브랜드/비브랜드로 **분리 산출**하기 위해 반드시 필요하다
 *   (설계서 3절: 둘을 합산하면 브랜드 검색이 점유율을 부풀린다).
 * - `nonbrand_core` — `지역 + 업종`. 경쟁사 비교의 기준 키워드다.
 * - `nonbrand_long` — `지역 + 시술`. 롱테일 공백 탐지용.
 *
 * @param limit 비브랜드 키워드 상한. 쿼터 예산과 직결된다.
 */
export function generateKeywords(input: KeywordInput, limit = 3): GeneratedKeyword[] {
  const term = INDUSTRY_TERM[input.industry];
  const region = searchRegion(input.regionSigungu);
  const out: GeneratedKeyword[] = [];

  // 상호가 지나치게 짧으면 브랜드 검색이 무의미하다 (`온`, `굿` 등).
  const brand = input.name.trim();
  if (normalizeCompanyName(brand).length >= 3) {
    out.push({ keyword: brand, kind: "brand", priority: 0, source: "template" });
  }

  const nonbrand: GeneratedKeyword[] = [];
  if (region) {
    nonbrand.push({ keyword: `${region} ${term}`, kind: "nonbrand_core", priority: 1, source: "template" });
    for (const [i, topic] of INDUSTRY_TOPICS[input.industry].entries()) {
      nonbrand.push({
        keyword: `${region} ${topic}`,
        kind: "nonbrand_long",
        priority: 2 + i,
        source: "template",
      });
    }
  } else {
    // 지역을 모르면 업종만으로는 전국 단위라 비교 의미가 없다. 브랜드만 남긴다.
    nonbrand.push({ keyword: term, kind: "nonbrand_core", priority: 1, source: "template" });
  }

  out.push(...nonbrand.slice(0, Math.max(limit, 0)));
  return out;
}

/** 경쟁사 비교에 쓸 단 하나의 키워드 (설계서 4.1 — 비브랜드 대표 1개로 한정). */
export function comparisonKeyword(input: KeywordInput): string | undefined {
  return generateKeywords(input, 1).find((k) => k.kind === "nonbrand_core")?.keyword;
}
