import { nullLogger, redactUrl, type Logger } from "@leadops/core";
import type { HttpClient } from "./client";
import {
  decideFromCache,
  parseRobotsTxt,
  ROBOTS_TTL_MS,
  type RobotsCacheEntry,
  type RobotsDecision,
} from "./robots";

/**
 * robots.txt 게이트.
 *
 * 도메인마다 robots.txt 를 한 번만 받아 캐시하고, 경로별 허용 여부를 판정한다.
 *
 * 원칙 (설계서 3.5절):
 *  - 404/410 → robots.txt 가 없는 것이므로 **전면 허용** (표준 동작)
 *  - 그 외 실패 → **fail-closed**. 판단할 수 없으면 가지 않는다.
 *  - 같은 오리진에 동시에 여러 요청이 와도 robots.txt 는 **한 번만** 받는다.
 */

/** robots.txt 로 인정할 최대 크기. 이보다 크면 판단하지 않고 막는다. */
const MAX_ROBOTS_BYTES = 512 * 1024;

/** robots.txt 는 text/plain 이지만 오설정한 서버가 많아 넓게 받는다. */
const ROBOTS_CONTENT_TYPES = Object.freeze([
  "text/plain",
  "text/html",
  "application/xhtml+xml",
  "application/octet-stream",
  "text/x-robots",
]);

/**
 * User-Agent 헤더에서 robots.txt 그룹 조회에 쓸 토큰을 뽑는다.
 *
 * `LeadOpsBot/1.0 (+https://example.kr/bot)` → `leadopsbot`
 * robots.txt 의 `User-agent:` 값은 제품 토큰이지 전체 UA 문자열이 아니다.
 */
export function userAgentToken(userAgent: string): string {
  const first = userAgent.trim().split(/[\s/]/)[0] ?? "";
  return first.toLowerCase();
}

export interface RobotsGateOptions {
  client: HttpClient;
  /** robots.txt 그룹 선택에 쓰는 UA 토큰 (예: `leadopsbot`). */
  userAgentToken: string;
  logger?: Logger;
  ttlMs?: number;
  now?: () => number;
}

export interface GateDecision extends RobotsDecision {
  /** robots.txt 를 받지 못한 사유. 관측 기록용. */
  failure?: RobotsCacheEntry["failure"];
}

export class RobotsGate {
  readonly #client: HttpClient;
  readonly #token: string;
  readonly #log: Logger;
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, RobotsCacheEntry>();
  /** 진행 중인 조회. 같은 오리진에 대한 중복 요청을 합친다. */
  readonly #inflight = new Map<string, Promise<RobotsCacheEntry>>();

  constructor(options: RobotsGateOptions) {
    this.#client = options.client;
    this.#token = options.userAgentToken;
    this.#log = options.logger ?? nullLogger;
    this.#ttl = options.ttlMs ?? ROBOTS_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** 이 URL 을 가져와도 되는지. */
  async check(rawUrl: string): Promise<GateDecision> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, failure: "fetch_error" };
    }

    const entry = await this.#entryFor(url.origin);
    const decision = decideFromCache(entry, this.#token, `${url.pathname}${url.search}`);
    return entry.failure === undefined ? decision : { ...decision, failure: entry.failure };
  }

  async #entryFor(origin: string): Promise<RobotsCacheEntry> {
    const cached = this.#cache.get(origin);
    if (cached && this.#now() - cached.fetchedAt < this.#ttl) return cached;

    const pending = this.#inflight.get(origin);
    if (pending) return pending;

    const task = this.#fetch(origin)
      .then((entry) => {
        this.#cache.set(origin, entry);
        return entry;
      })
      .finally(() => {
        this.#inflight.delete(origin);
      });

    this.#inflight.set(origin, task);
    return task;
  }

  async #fetch(origin: string): Promise<RobotsCacheEntry> {
    const url = `${origin}/robots.txt`;
    const fetchedAt = this.#now();
    try {
      const res = await this.#client.get(url, {
        acceptContentTypes: ROBOTS_CONTENT_TYPES,
        allowNotFound: true,
        allowErrorStatuses: true,
        // robots.txt 가 5xx 를 준다고 여러 번 두드릴 이유가 없다. 한 번 더까지만.
        maxRetries: 1,
      });

      if (res.status === 404 || res.status === 410) {
        return { robots: null, failure: "not_found", fetchedAt };
      }
      if (res.status >= 400) {
        this.#log.warn("robots.status", { url: redactUrl(url), status: res.status });
        return { robots: null, failure: "fetch_error", fetchedAt };
      }
      // 잘렸다면 뒷부분에 우리를 막는 규칙이 있었을 수 있다. 모르면 가지 않는다.
      if (res.truncated || res.body.length > MAX_ROBOTS_BYTES) {
        return { robots: null, failure: "too_large", fetchedAt };
      }
      return { robots: parseRobotsTxt(res.body), fetchedAt };
    } catch (err) {
      this.#log.warn("robots.error", {
        url: redactUrl(url),
        error: err instanceof Error ? err.message : String(err),
      });
      return { robots: null, failure: "fetch_error", fetchedAt };
    }
  }
}
