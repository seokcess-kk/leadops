/**
 * robots.txt 파서.
 *
 * 설계서 F-25 / R2-25 반영:
 *  - robots.txt 는 **법적 면허가 아니라** 운영 정책 신호다. 준수하되, 허용된다고
 *    다른 법적 문제(약관·저작권·정보통신망법)가 사라지는 것은 아니다.
 *  - `noindex` 는 색인 지시이지 fetch 금지가 아니므로 **차단 사유로 쓰지 않는다.**
 *    별도 메타데이터로만 기록한다.
 *  - 조회 실패 시 fail-closed (보수적으로 차단).
 *
 * 매칭 규칙은 Google 의 robots.txt 사양을 따른다:
 *  - 가장 구체적인 user-agent 그룹 하나만 적용 (정확 일치 > `*`)
 *  - 경로는 최장 일치 우선, 길이가 같으면 Allow 우선
 *  - `*` (임의 문자열)와 `$` (문자열 끝) 지원
 */

export interface RobotsRule {
  type: "allow" | "disallow";
  pattern: string;
}

export interface RobotsTxt {
  /** user-agent 토큰(소문자) → 규칙 목록 */
  groups: Map<string, RobotsRule[]>;
  crawlDelaySec: Map<string, number>;
  sitemaps: string[];
}

export function parseRobotsTxt(text: string): RobotsTxt {
  const groups = new Map<string, RobotsRule[]>();
  const crawlDelaySec = new Map<string, number>();
  const sitemaps: string[] = [];

  let currentAgents: string[] = [];
  // user-agent 줄이 연속으로 나오면 하나의 그룹으로 묶인다.
  // 규칙 줄이 나온 뒤의 user-agent 줄은 새 그룹을 시작한다.
  let sawRuleSinceAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]!.trim();
    if (line.length === 0) continue;

    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case "user-agent": {
        if (sawRuleSinceAgent) {
          currentAgents = [];
          sawRuleSinceAgent = false;
        }
        const agent = value.toLowerCase();
        currentAgents.push(agent);
        if (!groups.has(agent)) groups.set(agent, []);
        break;
      }
      case "allow":
      case "disallow": {
        if (currentAgents.length === 0) break; // 그룹 밖의 규칙은 무시
        sawRuleSinceAgent = true;
        // "Disallow:" (빈 값) 은 "아무것도 막지 않음" 을 뜻하므로 규칙으로 넣지 않는다.
        if (field === "disallow" && value === "") break;
        for (const a of currentAgents) {
          groups.get(a)!.push({ type: field, pattern: value });
        }
        break;
      }
      case "crawl-delay": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) {
          for (const a of currentAgents) crawlDelaySec.set(a, n);
        }
        sawRuleSinceAgent = true;
        break;
      }
      case "sitemap": {
        if (value) sitemaps.push(value);
        break;
      }
      default:
        break;
    }
  }

  return { groups, crawlDelaySec, sitemaps };
}

/** robots.txt 는 원격 입력이다. 병적인 패턴이 우리 CPU 를 태우지 않게 상한을 둔다. */
const MAX_PATTERN_LENGTH = 512;
const MAX_WILDCARDS = 12;

const patternCache = new Map<string, RegExp | null>();

/**
 * robots 패턴을 정규식으로 변환한다. `*` 와 `$` 만 특수 문자다.
 *
 * ❗ ReDoS 방어:
 *   - 연속된 `*` 를 하나로 접는다. `***` → `.*.*.*` 는 중첩 백트래킹의 원인이다.
 *   - 와일드카드 개수와 패턴 길이에 상한을 둔다. 넘으면 `null` 을 돌려주고
 *     해당 규칙을 **무시**한다(허용도 차단도 아님 — 다른 규칙이 판단한다).
 *   - 컴파일 결과를 캐시해 경로마다 다시 만들지 않는다.
 */
function patternToRegExp(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached;

  const result = compilePattern(pattern);
  patternCache.set(pattern, result);
  return result;
}

function compilePattern(pattern: string): RegExp | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  // 연속 와일드카드 접기
  const collapsed = pattern.replace(/\*{2,}/g, "*");
  const wildcards = (collapsed.match(/\*/g) ?? []).length;
  if (wildcards > MAX_WILDCARDS) return null;

  let re = "^";
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i] as string;
    if (ch === "*") {
      re += ".*";
    } else if (ch === "$" && i === collapsed.length - 1) {
      re += "$";
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(re);
}

interface SelectedGroup {
  /** robots.txt 에 쓰인 user-agent 키. crawl-delay 조회에 같은 키를 써야 한다. */
  agent: string;
  rules: RobotsRule[];
}

/** 이 로봇에 적용될 그룹을 고른다. 접두 일치 중 가장 긴 것 > `*` > 없음. */
function selectGroup(robots: RobotsTxt, userAgentToken: string): SelectedGroup | undefined {
  const token = userAgentToken.toLowerCase();
  let best: SelectedGroup | undefined;
  for (const [agent, rules] of robots.groups) {
    if (agent === "*" || agent === "") continue;
    if (token.startsWith(agent)) {
      if (!best || agent.length > best.agent.length) best = { agent, rules };
    }
  }
  if (best) return best;
  const star = robots.groups.get("*");
  return star ? { agent: "*", rules: star } : undefined;
}

export interface RobotsDecision {
  allowed: boolean;
  /** 매칭된 규칙. 없으면 기본 허용. */
  matched?: RobotsRule;
  crawlDelaySec?: number;
}

/**
 * 경로 접근 허용 여부.
 *
 * @param path URL 의 pathname + search
 */
export function isAllowed(robots: RobotsTxt, userAgentToken: string, path: string): RobotsDecision {
  const group = selectGroup(robots, userAgentToken);

  // ❗ crawl-delay 는 **선택된 그룹과 같은 키**로 조회해야 한다.
  //    전체 UA 토큰("leadopsbot/1.0")으로 찾으면 `User-agent: LeadOpsBot` 그룹의
  //    Crawl-delay 가 적용되지 않는다.
  const delay = group
    ? (robots.crawlDelaySec.get(group.agent) ?? robots.crawlDelaySec.get("*"))
    : robots.crawlDelaySec.get("*");
  const base: RobotsDecision = delay === undefined ? { allowed: true } : { allowed: true, crawlDelaySec: delay };

  if (!group || group.rules.length === 0) return base;

  let best: { rule: RobotsRule; len: number } | undefined;
  for (const rule of group.rules) {
    if (rule.pattern === "") continue;
    const re = patternToRegExp(rule.pattern);
    if (re === null) continue; // 병적인 패턴 — 무시한다
    if (!re.test(path)) continue;
    const len = rule.pattern.length;
    if (!best || len > best.len || (len === best.len && rule.type === "allow")) {
      best = { rule, len };
    }
  }

  if (!best) return base;
  return { ...base, allowed: best.rule.type === "allow", matched: best.rule };
}

/** 캐시 엔트리. 조회 실패도 캐시해서 같은 도메인을 반복 두드리지 않는다. */
export interface RobotsCacheEntry {
  robots: RobotsTxt | null;
  /**
   * null 인 경우의 사유. 'not_found'(404/410)와 'unavailable_4xx'(그 외 4xx —
   * RFC 9309 §2.3.1.3 · D-005)는 전면 허용, 그 외는 fail-closed.
   */
  failure?: "not_found" | "unavailable_4xx" | "fetch_error" | "too_large";
  fetchedAt: number;
}

export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 조회 결과로부터 접근 허용 여부를 판정한다.
 *
 * - 200 + 본문 → 파싱 결과에 따름
 * - 404/410    → robots.txt 가 없는 것이므로 **전면 허용** (표준 동작)
 * - 그 외 4xx  → **전면 허용** (RFC 9309 §2.3.1.3 "unavailable" · 발주자 결정 D-005)
 * - 5xx·네트워크 실패 → **fail-closed. 차단한다.**
 */
export function decideFromCache(
  entry: RobotsCacheEntry,
  userAgentToken: string,
  path: string,
): RobotsDecision {
  if (entry.robots) return isAllowed(entry.robots, userAgentToken, path);
  if (entry.failure === "not_found" || entry.failure === "unavailable_4xx") {
    return { allowed: true };
  }
  return { allowed: false };
}
