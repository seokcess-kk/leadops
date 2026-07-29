/**
 * 도메인 분류 — 공식 홈페이지 오판 방지 (설계서 R10).
 *
 * 가장 흔한 오판은 애그리게이터(병원 포털·지도·예약)를 그 업체의 공식 홈페이지로
 * 착각하는 것이다. HIRA 의 `hospUrl` 에도 네이버 플레이스나 블로그 주소가 들어오는
 * 경우가 있다. 도메인 분류는 그 오판을 **다신호 합산 이전에** 잘라낸다.
 *
 * ❗ 이 목록은 규칙이지 진실이 아니다. Phase 3 골드셋 검증(M2 정밀도 ≥ 0.90 /
 *    재현율 ≥ 0.75)에서 오분류가 나오면 목록과 가중치를 함께 고친다.
 */

export type DomainClass =
  /** 여러 업체를 모아 보여주는 포털·지도·예약·채용. 특정 업체의 공식 홈페이지일 수 없다. */
  | "aggregator"
  /** SNS·블로그·동영상. 공식 **채널**일 수는 있으나 공식 **홈페이지**는 아니다. */
  | "social"
  /** 임대형·무료 홈페이지 빌더. 소상공인의 진짜 공식 홈페이지인 경우가 많으므로 감점만 한다. */
  | "builder"
  /** 단축 URL. 최종 목적지로 재판정해야 한다. */
  | "shortener"
  /** 위 어디에도 해당하지 않는 자체 도메인. */
  | "own";

/**
 * 애그리게이터. 이 도메인이면 공식 홈페이지가 아니다.
 *
 * 병원 포털·지도·예약·채용·커머스처럼 **여러 업체가 한 도메인 아래 나열되는** 서비스만
 * 넣는다. 특정 업체 전용이 될 수 있는 도메인은 넣지 않는다.
 */
const AGGREGATOR = [
  // 지도·플레이스
  "place.naver.com", "map.naver.com", "m.place.naver.com", "map.kakao.com", "place.map.kakao.com",
  "maps.google.com", "google.com/maps",
  // 병원·시술 포털
  "goodoc.co.kr", "gangnamunni.com", "babitalk.com", "modoodoc.com", "doctornow.co.kr",
  "yeoshin.co.kr", "hidoc.co.kr", "mocamoca.com",
  // 채용 (업체 소개 페이지가 있지만 공식 홈페이지는 아니다)
  "saramin.co.kr", "jobkorea.co.kr", "incruit.com", "wanted.co.kr", "work.go.kr", "albamon.com",
  // 커머스·주문
  "smartstore.naver.com", "shopping.naver.com", "coupang.com", "baemin.com", "yogiyo.co.kr",
  // 공공 조회 서비스 (가맹사업거래 등)
  "franchise.ftc.go.kr", "www.ftc.go.kr",
] as const;

/** SNS·블로그. 공식 채널 분석에는 쓰지만 홈페이지로는 인정하지 않는다. */
const SOCIAL = [
  "blog.naver.com", "m.blog.naver.com", "cafe.naver.com", "post.naver.com", "in.naver.com",
  "blog.me", "tistory.com", "blogspot.com", "blogger.com", "wordpress.com", "brunch.co.kr",
  "instagram.com", "facebook.com", "fb.com", "youtube.com", "youtu.be",
  "twitter.com", "x.com", "threads.net", "tiktok.com",
  "pf.kakao.com", "story.kakao.com", "band.us", "linkedin.com",
] as const;

/**
 * 임대형·무료 빌더.
 *
 * ❗ 배제하지 않는다. 네이버 `modoo.at` 이나 `cafe24` 임대 도메인은 소상공인의 실제
 *    공식 홈페이지인 경우가 흔하다. 자체 도메인보다 신뢰도를 조금 낮출 뿐이다.
 */
const BUILDER = [
  "modoo.at", "imweb.me", "cafe24.com", "wixsite.com", "wix.com", "weebly.com",
  "squarespace.com", "creatorlink.net", "godomall.com", "shopify.com",
  "github.io", "netlify.app", "vercel.app", "webnode.kr", "jimdosite.com",
] as const;

/** 단축 URL. HttpClient 가 redirect 를 따라가므로 최종 URL 로 다시 판정한다. */
const SHORTENER = [
  "bit.ly", "naver.me", "goo.gl", "tinyurl.com", "han.gl", "url.kr", "buly.kr", "me2.do", "kko.to",
] as const;

const TABLE: ReadonlyArray<readonly [DomainClass, readonly string[]]> = [
  ["aggregator", AGGREGATOR],
  ["social", SOCIAL],
  ["builder", BUILDER],
  ["shortener", SHORTENER],
];

/**
 * 도메인 하나를 분류한다.
 *
 * `domain` 은 `canonicalizeUrl` 을 통과한 소문자·`www.` 제거 형태를 기대한다.
 * 서브도메인 일치는 접미사로 판정하되 **레이블 경계**를 지킨다 —
 * `notinstagram.com` 이 `instagram.com` 으로 잡히면 안 된다.
 */
export function classifyDomain(domain: string): DomainClass {
  const d = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  for (const [cls, list] of TABLE) {
    for (const entry of list) {
      if (d === entry || d.endsWith(`.${entry}`)) return cls;
    }
  }
  return "own";
}

/** 공식 홈페이지가 될 수 **없는** 분류인지. */
export function isDisqualifyingClass(cls: DomainClass): boolean {
  return cls === "aggregator" || cls === "social";
}

/**
 * 같은 도메인에 이만큼 이상의 다른 업체가 묶여 있으면 애그리게이터로 본다.
 *
 * 목록에 없는 신종 포털을 잡는 안전망이다. 임계값이 낮으면 한 법인이 운영하는
 * 다지점 병원(같은 도메인 공유)이 걸리므로 넉넉하게 잡는다.
 */
export const SHARED_DOMAIN_LIMIT = 5;
