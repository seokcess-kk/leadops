import { z } from "zod";
import { configError } from "./errors";

/**
 * 환경변수 검증.
 *
 * 원칙 (설계서 11장 "실데이터 미준비 부분의 처리 원칙"):
 *  - 누락 시 즉시 종료한다. 조용한 폴백 없음.
 *  - mock 어댑터는 production 빌드에서 부팅을 실패시킨다.
 *  - ORS 가 off 가 아닌데 네이버 자격증명이 없으면 부팅을 실패시킨다.
 */

const nonEmpty = z.string().trim().min(1);
const optionalStr = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

export const OrsMode = z.enum(["off", "shadow", "on"]);
export type OrsMode = z.infer<typeof OrsMode>;

export const SourceMode = z.enum(["live", "mock"]);
export type SourceMode = z.infer<typeof SourceMode>;

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    FEATURE_SOURCE: SourceMode.default("mock"),
    FEATURE_ORS: OrsMode.default("off"),
    FEATURE_LLM: z.enum(["off", "on"]).default("off"),

    ANTHROPIC_API_KEY: optionalStr,
    LLM_MONTHLY_CAP_KRW: z.coerce.number().int().nonnegative().default(15_000),

    DATA_GO_KR_SERVICE_KEY: optionalStr,

    NAVER_CLIENT_ID: optionalStr,
    NAVER_CLIENT_SECRET: optionalStr,
    NAVER_DAILY_CALL_CAP: z.coerce.number().int().positive().max(25_000).default(20_000),

    YOUTUBE_API_KEY: optionalStr,

    HTTP_USER_AGENT: nonEmpty.default("LeadOpsBot/1.0 (+https://example.kr/bot)"),
    HTTP_PER_DOMAIN_INTERVAL_MS: z.coerce.number().int().min(0).default(2_000),
    HTTP_GLOBAL_CONCURRENCY: z.coerce.number().int().positive().max(64).default(8),
    HTTP_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    HTTP_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    HTTP_MAX_BODY_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
    HTTP_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),

    SPIKE_OUT_DIR: nonEmpty.default("./out"),
  })
  .superRefine((env, ctx) => {
    // mock 어댑터가 프로덕션으로 새어 나가는 것을 막는다.
    if (env.NODE_ENV === "production" && env.FEATURE_SOURCE === "mock") {
      ctx.addIssue({
        code: "custom",
        path: ["FEATURE_SOURCE"],
        message: "production 에서는 FEATURE_SOURCE=mock 을 사용할 수 없습니다.",
      });
    }

    if (env.FEATURE_SOURCE === "live" && !env.DATA_GO_KR_SERVICE_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["DATA_GO_KR_SERVICE_KEY"],
        message: "FEATURE_SOURCE=live 에는 공공데이터포털 serviceKey 가 필요합니다.",
      });
    }

    // ORS 가 켜져 있으면 네이버 자격증명이 반드시 있어야 한다 (fail-closed).
    if (env.FEATURE_ORS !== "off") {
      if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
        ctx.addIssue({
          code: "custom",
          path: ["FEATURE_ORS"],
          message:
            "FEATURE_ORS 가 off 가 아니면 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 가 필요합니다. " +
            "자격증명이 없으면 off 로 두세요 (축소 파이프라인으로 동작).",
        });
      }
    }

    if (env.FEATURE_LLM === "on" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "FEATURE_LLM=on 에는 ANTHROPIC_API_KEY 가 필요합니다.",
      });
    }

    if (env.HTTP_CONNECT_TIMEOUT_MS >= env.HTTP_TOTAL_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["HTTP_CONNECT_TIMEOUT_MS"],
        message: "연결 타임아웃은 전체 타임아웃보다 작아야 합니다.",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** 원시 환경변수를 검증한다. 실패하면 어떤 키가 왜 틀렸는지 전부 모아서 던진다. */
export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw configError(`환경변수 검증 실패:\n${lines.join("\n")}`, {
      issueCount: result.error.issues.length,
    });
  }
  return result.data;
}

let cached: Env | undefined;
let envFileLoaded = false;

/**
 * `.env` 를 읽어 `process.env` 에 채운다.
 *
 * Node 20.12+ 의 `process.loadEnvFile()` 을 쓰므로 dotenv 의존성이 없다.
 * 파일이 없으면 조용히 넘어간다 — `.env` 는 선택이고, 값이 정말 없으면
 * 바로 다음의 Zod 검증이 어느 키가 없는지 알려주며 부팅을 막는다.
 *
 * ❗ 이미 설정된 환경변수를 덮어쓰지 않는다. CI·컨테이너의 실제 환경이
 *    개발자의 로컬 `.env` 보다 우선해야 한다.
 */
export function loadEnvFile(path = ".env"): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  try {
    const before = { ...process.env };
    process.loadEnvFile(path);
    // loadEnvFile 은 기존 값을 덮어쓴다. 원래 값이 있었다면 되돌린다.
    for (const [k, v] of Object.entries(before)) {
      if (v !== undefined) process.env[k] = v;
    }
  } catch {
    // 파일 없음 — 정상. 검증은 parseEnv 가 한다.
  }
}

/** 프로세스 전역 환경. 최초 호출 시 `.env` 를 읽고, 검증하고, 캐시한다. */
export function getEnv(): Env {
  if (cached === undefined) {
    loadEnvFile();
    cached = parseEnv();
  }
  return cached;
}

/** 테스트 전용 — 캐시를 비운다. */
export function resetEnvCache(): void {
  cached = undefined;
  envFileLoaded = false;
}
