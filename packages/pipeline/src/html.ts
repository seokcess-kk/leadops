import { parse } from "node-html-parser";

/**
 * 홈페이지 판별용 HTML 스캐너.
 *
 * ❗ 이 모듈은 이메일을 다루지 않는다 (정보통신망법 제50조의2 · 설계서 결론 A).
 *    그 보장을 주석이 아니라 **자료형**으로 만든다: `PageScan` 에는 본문 텍스트가 없다.
 *    호출자가 받는 것은 title·og·링크·폼 수·숫자 스트림·길이뿐이므로, 본문에 이메일이
 *    있어도 스캐너 밖으로 나갈 통로가 없다. 판별 로직은 이 구조체만 보고 판단한다.
 *
 * 전화번호도 "추출"하지 않는다. 이미 공공 API 로 알고 있는 번호가 페이지 안에
 * 있는지를 **대조**할 뿐이다 (`phoneAppears`). 페이지에서 새 번호를 알아내지 않는다.
 */

/** 링크 수 상한. 사이트맵 페이지처럼 링크가 수천 개인 문서에서 작업량을 묶는다. */
const MAX_LINKS = 400;

/** 앵커 텍스트 상한. 링크 텍스트가 본문 전체인 병적인 마크업을 막는다. */
const MAX_LINK_TEXT = 120;

export interface PageLink {
  /** 원본 href (미해석). 절대 URL 변환은 호출자가 base 를 알고 있을 때 한다. */
  readonly href: string;
  /** 앵커 텍스트. 공백 정규화 후 상한까지 자른다. */
  readonly text: string;
  readonly rel?: string | undefined;
}

export interface PageScan {
  readonly title?: string | undefined;
  readonly siteName?: string | undefined;
  readonly description?: string | undefined;
  /**
   * F-25: `noindex` 는 색인 지시이지 fetch 금지가 아니다.
   * 차단 사유가 아니라 관측 메타데이터로만 기록한다.
   */
  readonly hasNoindex: boolean;
  readonly formCount: number;
  /** 잘리기 전 전체 `<a href>` 개수. */
  readonly linkCount: number;
  readonly links: readonly PageLink[];
  readonly linksTruncated: boolean;
  /**
   * 텍스트 블록별 숫자 스트림을 `|` 로 이어 붙인 것.
   *
   * 블록 경계를 넘어 숫자가 붙는 것을 막는다 — `<td>100</td><td>212345678</td>` 가
   * `100212345678` 로 합쳐지면 `0212345678` 이 우연히 포함돼 오탐이 난다.
   */
  readonly digits: string;
  /** 본문 텍스트 길이. 껍데기 페이지(플레이스홀더·주차 도메인) 판별용. */
  readonly textLength: number;
  /**
   * 본문에 주어진 문자열이 있는지 묻는다. **이미 알고 있는 값을 대조할 때만** 쓴다.
   *
   * 본문을 통째로 돌려주는 대신 예/아니오만 답하는 이유는, 이 구조체를 통해
   * 페이지에서 새로운 연락처를 알아낼 수 없게 하기 위해서다. 업체명·지역처럼
   * 우리가 이미 가진 값의 일치 여부만 확인된다.
   *
   * 비교 전에 양쪽을 NFKC 정규화하고 공백을 제거한 뒤 소문자로 맞춘다.
   */
  readonly contains: (needle: string) => boolean;
  /**
   * 껍데기 리다이렉트 페이지의 이동 목적지 (있을 때만).
   *
   * `<meta http-equiv="refresh">` 또는 인라인 스크립트의 리터럴 `location` 대입에서
   * 뽑는다. **내비게이션 목적지 URL 하나뿐이다** — 스크립트 안의 내용이 링크·전화
   * 신호가 되지 않는다는 격리 규칙은 그대로다 (links·digits·textLength 에 영향 없음).
   * 추적 여부·같은 출처 검증·robots 재확인은 호출자(homepage 스테이지)의 몫이다.
   */
  readonly redirectTarget?: string | undefined;
}

const foldForMatch = (s: string): string =>
  s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * 리터럴 `location` 대입 (`location.href = "..."` · `location.replace("...")`).
 * 변수·연산 대입은 잡지 않는다 — JS 를 실행하지 않으므로 리터럴만 신뢰할 수 있다.
 */
const LOCATION_ASSIGN =
  /(?:(?:window|document|top|self)\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']|location\.replace\(\s*["']([^"']+)["']\s*\)/g;

/**
 * 껍데기 리다이렉트 목적지를 뽑는다.
 *
 * meta refresh 가 스크립트 이동보다 우선한다 (선언적이라 신뢰도가 높다). 스크립트는
 * UA 분기(모바일 먼저, 데스크톱 나중이 관행)를 평가할 수 없으므로 **마지막 대입**을
 * 취한다. 원문 전체를 정규식으로 보지만, 결과는 URL 문자열 하나라 본문이 새지 않는다.
 */
function extractRedirectTarget(
  metas: readonly { equiv: string; content: string }[],
  rawHtml: string,
): string | undefined {
  for (const meta of metas) {
    if (meta.equiv !== "refresh") continue;
    const m = /url\s*=\s*['"]?([^'";\s]+)/i.exec(meta.content);
    if (m?.[1]) return m[1];
  }
  let last: string | undefined;
  for (const m of rawHtml.matchAll(LOCATION_ASSIGN)) last = m[1] ?? m[2] ?? last;
  return last;
}

/**
 * HTML 을 판별 신호로 축약한다.
 *
 * `<script>` · `<style>` · `<noscript>` 의 내용은 텍스트에서 제외된다. 이 처리가 없으면
 * 인라인 자바스크립트 문자열 안의 `<a href=...>` 이 실제 링크로 잡히고, 스크립트에
 * 박힌 숫자가 전화번호로 오인된다.
 */
export function scanHtml(html: string): PageScan {
  const root = parse(html, {
    comment: false,
    blockTextElements: { script: false, style: false, noscript: false, pre: true },
  });

  let siteName: string | undefined;
  let description: string | undefined;
  let hasNoindex = false;

  const equivMetas: Array<{ equiv: string; content: string }> = [];
  for (const meta of root.querySelectorAll("meta")) {
    const key = (meta.getAttribute("property") ?? meta.getAttribute("name") ?? "").toLowerCase();
    const content = meta.getAttribute("content");
    if (!content) continue;

    const equiv = (meta.getAttribute("http-equiv") ?? "").toLowerCase();
    if (equiv) equivMetas.push({ equiv, content });

    if (key === "og:site_name") siteName ??= collapse(content);
    else if (key === "og:description" || key === "description") description ??= collapse(content);
    // robots 지시는 쉼표 구분 토큰이다. `noindex` 가 다른 값의 부분문자열로 걸리지 않게 나눠 본다.
    else if (key === "robots" || key === "googlebot") {
      if (content.toLowerCase().split(/[,\s]+/).includes("noindex")) hasNoindex = true;
    }
  }

  const anchors = root.querySelectorAll("a");
  const links: PageLink[] = [];
  let linkCount = 0;

  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;
    linkCount++;
    if (links.length >= MAX_LINKS) continue;

    const rel = a.getAttribute("rel");
    links.push({
      href: href.trim(),
      text: collapse(a.text).slice(0, MAX_LINK_TEXT),
      ...(rel ? { rel: collapse(rel) } : {}),
    });
  }

  // structuredText 는 블록 경계에 줄바꿈을 넣으면서 인라인 요소로 쪼개진 문자열은
  // 붙여 준다. `<span>02</span>-<span>1234</span>` 가 `02-1234` 로 살아난다.
  const text = root.structuredText;
  const digitBlocks: string[] = [];
  for (const line of text.split("\n")) {
    const d = line.replace(/\D/g, "");
    if (d.length > 0) digitBlocks.push(d);
  }
  // `tel:` 링크는 본문 텍스트가 아니라 href 에 번호가 있다. 대조 대상에 함께 넣는다.
  for (const link of links) {
    if (/^tel:/i.test(link.href)) {
      const d = link.href.replace(/\D/g, "");
      if (d.length > 0) digitBlocks.push(d);
    }
  }

  const title = root.querySelector("title")?.text;
  // 대조 전용 사본. 이 문자열은 클로저 밖으로 나가지 않는다.
  const folded = foldForMatch(text);
  const redirectTarget = extractRedirectTarget(equivMetas, html);

  return {
    ...(title && collapse(title) ? { title: collapse(title) } : {}),
    ...(redirectTarget ? { redirectTarget } : {}),
    ...(siteName ? { siteName } : {}),
    ...(description ? { description } : {}),
    hasNoindex,
    formCount: root.querySelectorAll("form").length,
    linkCount,
    links,
    linksTruncated: linkCount > links.length,
    digits: digitBlocks.join("|"),
    textLength: collapse(text).length,
    contains: (needle: string): boolean => {
      const n = foldForMatch(needle);
      return n.length > 0 && folded.includes(n);
    },
  };
}

/**
 * 알고 있는 전화번호가 페이지에 나타나는지 **대조**한다.
 *
 * 추출이 아니라 포함 검사다. 페이지에서 번호를 알아내지 않으므로 저장할 것도 없다.
 * `phone` 은 `normalizePhone` 을 통과한 국내 형식(`0212345678`)을 기대한다.
 */
export function phoneAppears(scan: PageScan, phone: string | null | undefined): boolean {
  if (!phone) return false;
  const local = phone.replace(/\D/g, "");
  if (local.length < 9) return false;

  // `+82-2-1234-5678` 처럼 국가번호로 적힌 경우도 같은 번호다.
  const international = local.startsWith("0") ? `82${local.slice(1)}` : `82${local}`;
  return scan.digits.includes(local) || scan.digits.includes(international);
}
