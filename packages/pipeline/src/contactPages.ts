import type { PageLink } from "./html";

/**
 * 연락처 페이지 후보 탐지 (설계서 결론 A · R2-07).
 *
 * ❗ 이 모듈은 **링크의 URL 과 앵커 텍스트만** 본다. 후보 페이지의 본문은 가져오지 않는다.
 *    본문은 검수자의 브라우저만 연다. DB 에서도 `contact_pages.body_fetched` CHECK 제약이
 *    같은 것을 강제한다.
 *
 * ❗ `mailto:` 링크는 **버린다**. href 자체가 이메일 주소이므로, 이것을 후보 URL 로
 *    저장하면 그 순간 "홈페이지에서 이메일을 자동 수집"한 것이 된다
 *    (정보통신망법 제50조의2). 검수자가 페이지를 직접 열어 확인해야 한다.
 */

export type PageKind = "contact" | "about" | "privacy" | "terms" | "footer" | "partnership";

export interface ContactCandidate {
  readonly url: string;
  readonly pageKind: PageKind;
  readonly linkText: string;
  /**
   * 검수자가 이 페이지에서 실제로 업무용 이메일을 찾을 확률의 추정치.
   * 설계서 M3(연락처 페이지 후보 적중률 ≥ 50%)의 측정 대상이다.
   */
  readonly confidence: number;
}

/**
 * 유형별 기본 신뢰도.
 *
 * `privacy` 가 높은 이유: 개인정보처리방침은 개인정보보호책임자의 연락처를 적도록
 * 되어 있어 업무용 이메일이 공개돼 있을 확률이 실제로 가장 높은 축에 속한다.
 * `terms` 는 이메일이 없는 경우가 많아 낮게 둔다.
 */
const KIND_CONFIDENCE: Record<PageKind, number> = {
  partnership: 0.85,
  contact: 0.8,
  privacy: 0.78,
  footer: 0.6,
  about: 0.55,
  terms: 0.35,
};

interface Rule {
  readonly kind: PageKind;
  /** 앵커 텍스트에서 찾을 조각. 공백 제거·소문자 후 부분 일치. */
  readonly text: readonly string[];
  /** URL 경로에서 찾을 조각. */
  readonly path: readonly string[];
}

/** 순서가 우선순위다. 위에서 먼저 맞으면 그 유형으로 확정한다. */
const RULES: readonly Rule[] = [
  {
    kind: "partnership",
    text: ["제휴", "협력문의", "입점", "가맹문의", "창업문의", "가맹상담", "partnership", "franchise"],
    path: ["/partnership", "/partner", "/franchise", "/alliance", "/affiliate"],
  },
  {
    kind: "contact",
    text: [
      "연락처", "문의", "오시는길", "찾아오시는길", "상담신청", "예약문의", "고객센터",
      "contact", "inquiry", "inquiries", "location", "directions", "getintouch",
    ],
    path: ["/contact", "/inquiry", "/inquire", "/qna", "/counsel", "/location", "/directions", "/cs"],
  },
  {
    kind: "privacy",
    text: ["개인정보처리방침", "개인정보취급방침", "개인정보보호정책", "privacypolicy", "privacy"],
    path: ["/privacy", "/personal-info", "/privacypolicy"],
  },
  {
    kind: "terms",
    text: ["이용약관", "서비스약관", "termsofuse", "termsofservice", "terms"],
    path: ["/terms", "/agreement", "/tos"],
  },
  {
    kind: "footer",
    text: ["사업자정보", "회사정보", "사업자등록", "businessinfo"],
    path: ["/business-info", "/companyinfo"],
  },
  {
    kind: "about",
    // "둘러보기"·"갤러리"는 넣지 않는다 — 대개 시술 전후 사진 페이지라
    // 업무용 이메일이 없다. 적중률(M3)을 떨어뜨리는 쪽이 더 손해다.
    text: [
      "회사소개", "병원소개", "의원소개", "브랜드소개", "인사말",
      "about", "aboutus", "company", "greeting", "introduce",
    ],
    path: ["/about", "/company", "/intro", "/greeting", "/aboutus"],
  },
];

/** 절대 따라가지 않는 스킴. `mailto:` 를 여기 두는 것이 이 파일의 핵심이다. */
const REJECTED_SCHEMES = /^(mailto|tel|sms|javascript|data|file|ftp):/i;

/** 후보 상한. 검수자가 실제로 열어 볼 수 있는 개수를 넘겨 봐야 의미가 없다. */
const MAX_CANDIDATES = 12;

const fold = (s: string): string => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** 등록 가능 도메인 근사 — 같은 사이트인지 판단할 때만 쓴다. */
function sameSite(a: string, b: string): boolean {
  const norm = (h: string): string => h.toLowerCase().replace(/^www\./, "");
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  // 서브도메인 관계면 같은 사이트로 본다 (`clinic.example.kr` ↔ `example.kr`).
  return x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

function classify(href: string, path: string, text: string): PageKind | undefined {
  const foldedText = fold(text);
  const foldedPath = fold(path);
  const foldedHref = fold(href);

  for (const rule of RULES) {
    if (foldedText.length > 0 && rule.text.some((t) => foldedText.includes(t))) return rule.kind;
    if (rule.path.some((p) => foldedPath.includes(p))) return rule.kind;
    // 쿼리스트링으로 라우팅하는 옛 사이트: `/bbs/page.php?code=contact`
    if (foldedHref.includes("?") && rule.path.some((p) => foldedHref.includes(p.slice(1)))) {
      return rule.kind;
    }
  }
  return undefined;
}

/**
 * 홈페이지 링크 목록에서 연락처 페이지 후보를 고른다.
 *
 * @param links `scanHtml` 이 뽑은 링크
 * @param baseUrl 상대 경로 해석 기준 (fetch 의 최종 URL)
 */
export function detectContactPages(
  links: readonly PageLink[],
  baseUrl: string,
): ContactCandidate[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const byUrl = new Map<string, ContactCandidate>();

  for (const link of links) {
    const href = link.href.trim();
    if (href.length === 0 || href.startsWith("#")) continue;
    // ❗ mailto: 를 후보로 기록하면 이메일을 수집한 것이 된다. 여기서 끝낸다.
    if (REJECTED_SCHEMES.test(href)) continue;

    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    // 외부 사이트의 연락처 페이지는 이 업체의 것이 아니다.
    if (!sameSite(abs.hostname, base.hostname)) continue;

    const kind = classify(href, abs.pathname, link.text);
    if (!kind) continue;

    // fragment 만 다른 링크는 같은 페이지다.
    abs.hash = "";
    const url = abs.toString();

    const candidate: ContactCandidate = {
      url,
      pageKind: kind,
      linkText: link.text,
      confidence: KIND_CONFIDENCE[kind],
    };

    const existing = byUrl.get(url);
    // 같은 URL 이 여러 앵커로 걸리면 더 신뢰도 높은 유형을 남긴다.
    if (!existing || existing.confidence < candidate.confidence) byUrl.set(url, candidate);
  }

  return [...byUrl.values()]
    .sort((a, b) => b.confidence - a.confidence || a.url.localeCompare(b.url))
    .slice(0, MAX_CANDIDATES);
}
