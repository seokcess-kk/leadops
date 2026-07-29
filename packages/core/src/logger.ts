import { redactPII } from "./redact";

/**
 * 구조화 로거.
 *
 * ❗ 모든 구조화 필드는 출력 직전 `redactPII()` 를 통과한다.
 *    설계서 R7 대응 — 이메일·담당자 정보가 로그를 통해 국외 로그 수집기로 나가는 것을 막는다.
 *    호출자가 마스킹을 잊어도 로거가 강제한다.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 테스트에서 출력을 가로채기 위한 싱크. 기본은 stdout. */
  sink?: (line: string) => void;
  bindings?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const bindings = options.bindings ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const record = {
      t: new Date().toISOString(),
      level: lvl,
      msg,
      ...redactPII({ ...bindings, ...(fields ?? {}) }),
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) =>
      createLogger({
        level,
        sink,
        bindings: { ...bindings, ...extra },
      }),
  };
}

/** 아무것도 출력하지 않는 로거. 테스트 기본값. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
