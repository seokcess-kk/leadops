import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile, parseEnv, resetEnvCache } from "./env";
import { LeadOpsError } from "./errors";

const base = { NODE_ENV: "development", FEATURE_SOURCE: "mock" } satisfies NodeJS.ProcessEnv;

describe("parseEnv", () => {
  it("기본값으로 동작한다 (mock · ORS off · LLM off)", () => {
    const env = parseEnv(base);
    expect(env.FEATURE_SOURCE).toBe("mock");
    expect(env.FEATURE_ORS).toBe("off");
    expect(env.FEATURE_LLM).toBe("off");
    expect(env.HTTP_PER_DOMAIN_INTERVAL_MS).toBe(2000);
  });

  it("production 에서 mock 소스를 쓰면 부팅을 막는다", () => {
    expect(() => parseEnv({ NODE_ENV: "production", FEATURE_SOURCE: "mock" })).toThrowError(LeadOpsError);
    try {
      parseEnv({ NODE_ENV: "production", FEATURE_SOURCE: "mock" });
    } catch (e) {
      expect((e as LeadOpsError).code).toBe("config_error");
      expect((e as LeadOpsError).message).toContain("FEATURE_SOURCE");
    }
  });

  it("live 소스인데 공공데이터 키가 없으면 부팅을 막는다", () => {
    expect(() => parseEnv({ NODE_ENV: "development", FEATURE_SOURCE: "live" })).toThrowError(
      /DATA_GO_KR_SERVICE_KEY/,
    );
  });

  it("ORS 가 off 가 아닌데 네이버 자격증명이 없으면 부팅을 막는다 (fail-closed)", () => {
    expect(() => parseEnv({ ...base, FEATURE_ORS: "shadow" })).toThrowError(/NAVER_CLIENT_ID/);
    expect(() => parseEnv({ ...base, FEATURE_ORS: "on" })).toThrowError(/NAVER_CLIENT_ID/);
  });

  it("ORS 가 off 면 네이버 자격증명 없이도 통과한다 (축소 파이프라인)", () => {
    expect(parseEnv({ ...base, FEATURE_ORS: "off" }).FEATURE_ORS).toBe("off");
  });

  it("네이버 자격증명이 있으면 shadow 를 허용한다", () => {
    const env = parseEnv({
      ...base,
      FEATURE_ORS: "shadow",
      NAVER_CLIENT_ID: "id",
      NAVER_CLIENT_SECRET: "secret",
    });
    expect(env.FEATURE_ORS).toBe("shadow");
  });

  it("LLM=on 인데 키가 없으면 부팅을 막는다", () => {
    expect(() => parseEnv({ ...base, FEATURE_LLM: "on" })).toThrowError(/ANTHROPIC_API_KEY/);
  });

  it("네이버 일일 호출 상한이 25,000 을 넘으면 거부한다", () => {
    expect(() =>
      parseEnv({ ...base, NAVER_DAILY_CALL_CAP: "30000", FEATURE_ORS: "off" }),
    ).toThrowError(/NAVER_DAILY_CALL_CAP/);
  });

  it("연결 타임아웃이 전체 타임아웃 이상이면 거부한다", () => {
    expect(() =>
      parseEnv({ ...base, HTTP_CONNECT_TIMEOUT_MS: "20000", HTTP_TOTAL_TIMEOUT_MS: "15000" }),
    ).toThrowError(/HTTP_CONNECT_TIMEOUT_MS/);
  });

  it("빈 문자열은 미설정으로 취급한다", () => {
    expect(() => parseEnv({ ...base, FEATURE_SOURCE: "live", DATA_GO_KR_SERVICE_KEY: "   " })).toThrowError(
      /DATA_GO_KR_SERVICE_KEY/,
    );
  });
});

describe("loadEnvFile", () => {
  const touched: string[] = [];
  afterEach(() => {
    for (const k of touched.splice(0)) delete process.env[k];
    resetEnvCache();
  });

  const writeEnv = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "leadops-env-"));
    const path = join(dir, ".env");
    writeFileSync(path, contents, "utf8");
    return path;
  };

  it(".env 의 값을 process.env 에 채운다", () => {
    touched.push("LEADOPS_TEST_A");
    loadEnvFile(writeEnv("LEADOPS_TEST_A=from_file\n"));
    expect(process.env["LEADOPS_TEST_A"]).toBe("from_file");
  });

  it("❗ 이미 설정된 환경변수를 덮어쓰지 않는다 (CI·컨테이너가 우선)", () => {
    touched.push("LEADOPS_TEST_B");
    process.env["LEADOPS_TEST_B"] = "from_process";
    resetEnvCache();
    loadEnvFile(writeEnv("LEADOPS_TEST_B=from_file\n"));
    expect(process.env["LEADOPS_TEST_B"]).toBe("from_process");
  });

  it("파일이 없어도 던지지 않는다 (.env 는 선택)", () => {
    expect(() => loadEnvFile(join(tmpdir(), "leadops-does-not-exist", ".env"))).not.toThrow();
  });

  it("한 프로세스에서 두 번 읽지 않는다", () => {
    touched.push("LEADOPS_TEST_C");
    loadEnvFile(writeEnv("LEADOPS_TEST_C=first\n"));
    loadEnvFile(writeEnv("LEADOPS_TEST_C=second\n"));
    expect(process.env["LEADOPS_TEST_C"]).toBe("first");
  });
});
