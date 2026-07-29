import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { Transform, pipeline as streamPipeline } from "node:stream";
import { promisify } from "node:util";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { LeadOpsError, nullLogger, policyViolation, redactUrl, type Logger } from "@leadops/core";
import { backoffDelayMs, isRetryableStatus, parseRetryAfter } from "./backoff";
import { RateLimiter, rateLimitKey } from "./rateLimiter";
import {
  assertPeerAllowed,
  ENFORCE,
  resolveGuarded,
  validateUrl,
  type DnsResolver,
  type SsrfPolicy,
} from "./ssrf";

const pipelineAsync = promisify(streamPipeline);

/** 저장·파싱을 허용하는 Content-Type. */
export const ALLOWED_CONTENT_TYPES = Object.freeze([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
]);

export interface HttpClientOptions {
  userAgent: string;
  perDomainIntervalMs: number;
  globalConcurrency: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxRetries: number;
  maxBodyBytes: number;
  maxRedirects: number;
  logger?: Logger;
  resolver?: DnsResolver;
  sleep?: (ms: number) => Promise<void>;
  /** 기본값 ENFORCE. 완화는 loopbackPolicyForTests() 로만 가능하며 NODE_ENV=test 를 요구한다. */
  ssrfPolicy?: SsrfPolicy;
}

export interface FetchOptions {
  /** 기본 허용 목록 대신 사용할 Content-Type 목록. */
  acceptContentTypes?: readonly string[];
  headers?: Record<string, string>;
  /** 404 를 예외가 아니라 결과로 받고 싶을 때. */
  allowNotFound?: boolean;
  /**
   * 이 요청에 한해 재시도 횟수를 덮어쓴다.
   *
   * 엔드포인트 탐색처럼 "실패가 곧 정보"인 경우 0 으로 둔다.
   * (data.go.kr 은 미등록 서비스에 500 을 주는데, 이는 재시도해도 달라지지 않는다)
   */
  maxRetries?: number;
  /**
   * 4xx·5xx 를 예외가 아니라 결과로 받는다.
   *
   * ❗ 진단 목적 전용이다. data.go.kr 은 오류 상세를 **본문**에 담아 보내므로
   *    (`SERVICE_KEY_IS_NOT_REGISTERED_ERROR`, `NO_OPENAPI_SERVICE_ERROR` 등),
   *    상태 코드만 보고 던지면 가장 쓸모 있는 정보를 버리게 된다.
   *    일반 수집 경로에서는 쓰지 않는다.
   */
  allowErrorStatuses?: boolean;
}

export interface FetchResult {
  status: number;
  /** redirect 를 모두 따라간 뒤의 최종 URL. */
  finalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** 각 홉에서 실제로 연결한 IP. 감사용. */
  hops: Array<{ url: string; ip: string }>;
  truncated: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 정책을 지키는 HTTP 클라이언트.
 *
 * 이 클래스가 강제하는 것 (설계서 3.5절):
 *  - SSRF: URL 검증 → DNS 전 주소 검증 → **검증된 IP 로 직접 연결** → peer 재검증
 *          → redirect 홉마다 전부 반복
 *  - 속도: 도메인당 최소 간격, 전역 동시성 상한
 *  - 크기: 압축 **해제 후** 바이트 상한 (압축 폭탄 방지)
 *  - 시간: 연결·전체 타임아웃
 *  - 재시도: 지수 백오프 + Retry-After 존중, 정책 위반은 재시도하지 않음
 *
 * 이 클래스가 하지 않는 것:
 *  - **이메일 문자열 추출** (정보통신망법 제50조의2 · 설계서 결론 A)
 *    본문은 호출자에게 그대로 넘기고, 이메일 추출 유틸리티는 이 저장소 어디에도 없다.
 */
export class HttpClient {
  readonly #opts: HttpClientOptions;
  readonly #limiter: RateLimiter;
  readonly #log: Logger;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #policy: SsrfPolicy;

  constructor(options: HttpClientOptions) {
    this.#opts = options;
    this.#log = options.logger ?? nullLogger;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#policy = options.ssrfPolicy ?? ENFORCE;
    this.#limiter = new RateLimiter({
      perDomainIntervalMs: options.perDomainIntervalMs,
      globalConcurrency: options.globalConcurrency,
    });
  }

  get rateLimiter(): RateLimiter {
    return this.#limiter;
  }

  /** GET 요청. redirect 를 홉마다 재검증하며 따라간다. */
  async get(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
    const maxRetries = options.maxRetries ?? this.#opts.maxRetries;
    let attempt = 0;
    for (;;) {
      try {
        return await this.#getOnce(rawUrl, options);
      } catch (err) {
        const retryable = err instanceof LeadOpsError && err.retryable;
        if (!retryable || attempt >= maxRetries) throw err;

        const hinted = (err as LeadOpsError).details["retryAfterMs"];
        const delay =
          typeof hinted === "number" ? hinted : backoffDelayMs(attempt, { baseMs: 2_000, capMs: 30_000 });
        // ❗ URL 을 그대로 로그에 넣으면 공공데이터포털 serviceKey 가 로그에 남는다.
        this.#log.warn("http.retry", {
          url: redactUrl(rawUrl),
          attempt,
          delayMs: delay,
          code: (err as LeadOpsError).code,
        });
        await this.#sleep(delay);
        attempt++;
      }
    }
  }

  async #getOnce(rawUrl: string, options: FetchOptions): Promise<FetchResult> {
    // ❗ hops·에러·로그에 들어가는 URL 은 전부 마스킹된 형태다 (serviceKey 유출 방지).
    const hops: Array<{ url: string; ip: string }> = [];
    const safe = redactUrl(rawUrl);
    let current = rawUrl;

    for (let hop = 0; hop <= this.#opts.maxRedirects; hop++) {
      // ── 1단계: URL 형태 검증 (홉마다 반복) ──
      const validated = validateUrl(current, this.#policy);
      // ── 2단계: DNS 해석 후 전 주소 검증 ──
      const targets = await resolveGuarded(validated, this.#opts.resolver, this.#policy);
      const target = targets[0]!;

      // ❗ 슬롯은 **본문 수신까지** 잡고 있어야 한다. 응답 헤더만 받고 반납하면
      //    전역 동시성 상한이 실제 다운로드 수를 제한하지 못한다.
      const release = await this.#limiter.acquire(rateLimitKey(validated.url));
      let redirectTo: string | undefined;
      try {
        const res = await this.#send(
          validated.url,
          target.address,
          target.family,
          options.headers ?? {},
          `hop${hop}`,
        );
        hops.push({ url: redactUrl(validated.url.href), ip: target.address });

        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        // ── redirect ──
        if (status >= 300 && status < 400 && location) {
          res.resume(); // 본문 버림 (소켓 누수 방지)
          if (hop === this.#opts.maxRedirects) {
            throw policyViolation(`redirect 홉 상한(${this.#opts.maxRedirects}) 초과`, { url: safe, hops });
          }
          redirectTo = new URL(location, validated.url).href;
        } else if (status >= 400 && options.allowErrorStatuses) {
          // 진단 모드: 본문을 읽어서 그대로 돌려준다. 오류 상세가 거기에 있다.
          const { text, truncated } = await this.#readBody(res);
          return { status, finalUrl: validated.url.href, headers: res.headers, body: text, hops, truncated };
        } else if (status === 404 || status === 410) {
          res.resume();
          if (options.allowNotFound) {
            return { status, finalUrl: validated.url.href, headers: res.headers, body: "", hops, truncated: false };
          }
          throw new LeadOpsError("not_found", `${status} ${redactUrl(validated.url.href)}`, { details: { status } });
        } else if (status >= 400) {
          res.resume();
          const raw = res.headers["retry-after"];
          const retryAfterMs = parseRetryAfter(Array.isArray(raw) ? raw[0] : raw, Date.now());
          throw new LeadOpsError("http_error", `HTTP ${status} ${redactUrl(validated.url.href)}`, {
            retryable: isRetryableStatus(status),
            details: retryAfterMs === undefined ? { status } : { status, retryAfterMs },
          });
        } else {
          // ── Content-Type 허용 목록 ──
          const allowed = options.acceptContentTypes ?? ALLOWED_CONTENT_TYPES;
          const contentType = (res.headers["content-type"] ?? "").toString().split(";")[0]!.trim().toLowerCase();
          if (contentType !== "" && !allowed.includes(contentType)) {
            res.resume();
            throw policyViolation(`허용되지 않은 Content-Type: ${contentType}`, {
              url: redactUrl(validated.url.href),
              contentType,
            });
          }

          // ── 본문 읽기 (압축 해제 후 크기 제한) ──
          const { text, truncated } = await this.#readBody(res);
          return { status, finalUrl: validated.url.href, headers: res.headers, body: text, hops, truncated };
        }
      } finally {
        release();
      }

      if (redirectTo === undefined) {
        // 위 분기는 모두 return 하거나 throw 하므로 도달하지 않는다.
        throw policyViolation("redirect 대상을 결정하지 못했습니다", { url: safe, hops });
      }
      current = redirectTo;
    }

    throw policyViolation("redirect 처리에 실패했습니다", { url: safe, hops });
  }

  /**
   * 검증된 IP 로 직접 연결한다.
   *
   * `lookup` 을 덮어써 DNS 를 다시 타지 않게 하는 것이 DNS rebinding 방어의 핵심이다.
   * SNI·Host 헤더는 원래 호스트명이 유지된다.
   */
  #send(
    url: URL,
    address: string,
    family: 4 | 6,
    extraHeaders: Record<string, string>,
    context: string,
  ): Promise<IncomingMessage> {
    const isHttps = url.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;

    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = doRequest(
        {
          protocol: url.protocol,
          host: url.hostname,
          port: url.port === "" ? (isHttps ? 443 : 80) : Number(url.port),
          path: url.pathname + url.search,
          method: "GET",
          servername: isHttps ? url.hostname : undefined,
          headers: {
            host: url.host,
            "user-agent": this.#opts.userAgent,
            accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1",
            "accept-encoding": "gzip, deflate, br",
            ...extraHeaders,
          },
          // ❗ SSRF 방어의 핵심: 이미 검증한 주소로만 연결한다.
          lookup: (_hostname, opts, cb) => {
            const callback = cb as (
              err: NodeJS.ErrnoException | null,
              addr: string | Array<{ address: string; family: number }>,
              fam?: number,
            ) => void;
            if (typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all) {
              callback(null, [{ address, family }]);
            } else {
              callback(null, address, family);
            }
          },
        },
        (res) => {
          // ── 4단계: 실제 peer 재검증 (TOCTOU) ──
          try {
            assertPeerAllowed(res.socket.remoteAddress, context, this.#policy);
          } catch (e) {
            res.destroy();
            req.destroy();
            reject(e);
            return;
          }
          resolve(res);
        },
      );

      // ❗ 하드 데드라인. `req.setTimeout` 은 **무활동** 타임아웃이라 조금씩 응답을
      //    흘려보내는 서버에는 걸리지 않는다. 전체 소요 시간을 별도로 끊는다.
      const deadline = setTimeout(() => {
        req.destroy(new LeadOpsError("timeout", `요청 데드라인 초과: ${redactUrl(url.href)}`, { retryable: true }));
      }, this.#opts.totalTimeoutMs);
      deadline.unref?.();
      const clearDeadline = (): void => clearTimeout(deadline);
      req.once("close", clearDeadline);

      req.setTimeout(this.#opts.totalTimeoutMs, () => {
        req.destroy(new LeadOpsError("timeout", `요청 무활동 타임아웃: ${redactUrl(url.href)}`, { retryable: true }));
      });

      req.on("socket", (socket: Socket) => {
        const onConnect = (): void => {
          // ❗ 연결 타임아웃은 여기서 해제한다. 남겨 두면 연결 이후에도 idle 타임아웃으로
          //    작동해 정상적인 느린 응답을 connectTimeoutMs 에 끊어 버린다.
          socket.setTimeout(0);
          try {
            assertPeerAllowed(socket.remoteAddress, context, this.#policy);
          } catch (e) {
            socket.destroy();
            req.destroy();
            reject(e);
          }
        };
        if (socket.connecting) {
          socket.setTimeout(this.#opts.connectTimeoutMs, () => {
            req.destroy(new LeadOpsError("timeout", `연결 타임아웃: ${redactUrl(url.href)}`, { retryable: true }));
          });
          socket.once("connect", onConnect);
        } else {
          onConnect();
        }
      });

      req.on("error", (err) => {
        clearDeadline();
        if (err instanceof LeadOpsError) reject(err);
        else reject(new LeadOpsError("http_error", `요청 실패: ${redactUrl(url.href)} (${err.message})`, { retryable: true, cause: err }));
      });

      req.end();
    });
  }

  /** 압축을 풀면서 바이트 수를 세고, 상한을 넘으면 스트림을 끊는다. */
  async #readBody(res: IncomingMessage): Promise<{ text: string; truncated: boolean }> {
    const encoding = (res.headers["content-encoding"] ?? "").toString().toLowerCase();
    const decompressor =
      encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;

    const maxBytes = this.#opts.maxBodyBytes;
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;

    // 압축 **해제 후** 바이트를 센다.
    // ❗ 상한에 닿으면 남은 chunk 를 버리는 것으로는 부족하다. 그러면 압축 폭탄이
    //    EOF 까지 계속 해제되어 CPU·대역폭을 그대로 태운다. 즉시 상류를 끊는다.
    const capper = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (truncated) {
          cb();
          return;
        }
        const remaining = maxBytes - total;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        total += slice.length;
        if (slice.length > 0) chunks.push(Buffer.from(slice));

        if (total >= maxBytes) {
          truncated = true;
          cb();
          // 상류(응답 소켓·압축 해제기)를 즉시 파괴해 더 읽지 않는다.
          res.destroy();
          decompressor?.destroy();
          this.destroy();
          return;
        }
        cb();
      },
    });

    try {
      if (decompressor) await pipelineAsync(res, decompressor, capper);
      else await pipelineAsync(res, capper);
    } catch (err) {
      // 상한 도달로 **우리가** 끊은 경우는 정상 결과(truncated)로 처리한다.
      if (!truncated) {
        throw new LeadOpsError("http_error", `본문 읽기 실패: ${(err as Error).message}`, {
          retryable: true,
          cause: err,
        });
      }
    }

    return { text: Buffer.concat(chunks).toString("utf8"), truncated };
  }
}

/** 환경 설정으로부터 클라이언트를 만든다. */
export function createHttpClient(
  env: {
    HTTP_USER_AGENT: string;
    HTTP_PER_DOMAIN_INTERVAL_MS: number;
    HTTP_GLOBAL_CONCURRENCY: number;
    HTTP_CONNECT_TIMEOUT_MS: number;
    HTTP_TOTAL_TIMEOUT_MS: number;
    HTTP_MAX_RETRIES: number;
    HTTP_MAX_BODY_BYTES: number;
    HTTP_MAX_REDIRECTS: number;
  },
  extra: { logger?: Logger; resolver?: DnsResolver; ssrfPolicy?: SsrfPolicy } = {},
): HttpClient {
  return new HttpClient({
    userAgent: env.HTTP_USER_AGENT,
    perDomainIntervalMs: env.HTTP_PER_DOMAIN_INTERVAL_MS,
    globalConcurrency: env.HTTP_GLOBAL_CONCURRENCY,
    connectTimeoutMs: env.HTTP_CONNECT_TIMEOUT_MS,
    totalTimeoutMs: env.HTTP_TOTAL_TIMEOUT_MS,
    maxRetries: env.HTTP_MAX_RETRIES,
    maxBodyBytes: env.HTTP_MAX_BODY_BYTES,
    maxRedirects: env.HTTP_MAX_REDIRECTS,
    ...extra,
  });
}
