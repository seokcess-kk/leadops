/**
 * 속도 제한 (설계서 3.5절).
 *
 *  - 도메인당 최소 요청 간격 (기본 2,000ms)
 *  - 전역 동시 실행 상한 (기본 8)
 *
 * `crawl-delay` 가 우리 기본 간격보다 크면 그쪽을 따른다 — 상대 서버의 요청을
 * 우리 설정보다 우선한다.
 */

export interface RateLimiterOptions {
  perDomainIntervalMs: number;
  globalConcurrency: number;
  /** 테스트 주입용. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  readonly #perDomainIntervalMs: number;
  readonly #globalConcurrency: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  /** 도메인별 "다음 요청을 보낼 수 있는 가장 이른 시각". */
  readonly #nextAvailableAt = new Map<string, number>();
  /** 도메인별 crawl-delay 오버라이드 (ms). */
  readonly #domainDelayMs = new Map<string, number>();

  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(options: RateLimiterOptions) {
    if (options.globalConcurrency < 1) throw new Error("globalConcurrency must be >= 1");
    this.#perDomainIntervalMs = options.perDomainIntervalMs;
    this.#globalConcurrency = options.globalConcurrency;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** robots.txt 의 crawl-delay 를 반영한다. 우리 기본 간격보다 큰 경우에만 적용. */
  setCrawlDelay(domain: string, seconds: number): void {
    const ms = Math.round(seconds * 1000);
    if (ms > this.#perDomainIntervalMs) this.#domainDelayMs.set(domain, ms);
  }

  intervalFor(domain: string): number {
    return this.#domainDelayMs.get(domain) ?? this.#perDomainIntervalMs;
  }

  get activeCount(): number {
    return this.#active;
  }

  /**
   * 도메인 슬롯을 확보한다. 반환된 함수를 반드시 호출해 슬롯을 반납해야 한다.
   *
   * 도메인 간격은 **슬롯 확보 시점에 미리 예약**한다. 그래야 같은 도메인에 대한
   * 동시 요청들이 서로 겹치지 않고 줄을 선다.
   */
  async acquire(domain: string): Promise<() => void> {
    await this.#acquireGlobalSlot();

    const now = this.#now();
    const interval = this.intervalFor(domain);
    const earliest = this.#nextAvailableAt.get(domain) ?? 0;
    const startAt = Math.max(now, earliest);
    this.#nextAvailableAt.set(domain, startAt + interval);

    const waitMs = startAt - now;
    if (waitMs > 0) await this.#sleep(waitMs);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseGlobalSlot();
    };
  }

  async #acquireGlobalSlot(): Promise<void> {
    if (this.#active < this.#globalConcurrency) {
      this.#active++;
      return;
    }
    // ❗ 대기자가 깨어난 시점에 다시 증가시키면 안 된다.
    //    release 가 슬롯을 **양도**하므로 카운트는 이미 우리 것이다.
    //    (증가시키면: release 가 N-1 로 낮춘 뒤 새 acquire 가 그 틈에 N 으로 올리고,
    //     이어서 깨어난 대기자가 N+1 로 만들어 동시성 상한을 넘긴다.)
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #releaseGlobalSlot(): void {
    const next = this.#waiters.shift();
    if (next) {
      next(); // 슬롯 양도 — #active 는 그대로 둔다
      return;
    }
    this.#active--;
  }
}

/** URL 에서 rate limit 키로 쓸 도메인을 뽑는다. */
export function rateLimitKey(url: URL): string {
  return url.hostname.toLowerCase();
}
