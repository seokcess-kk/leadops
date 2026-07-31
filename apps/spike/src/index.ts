#!/usr/bin/env node
import { formatVerification, verifyAdapters } from "@leadops/adapters";
import { configError, createLogger, getEnv, Industry, LeadOpsError, type Industry as IndustryT } from "@leadops/core";
import { createHttpClient } from "@leadops/http";
import { flagBool, flagNumber, flagString, parseArgs } from "./cli";
import { formatMeasureReport, runMeasure } from "./measure";
import { formatSampleReport, runSample } from "./sample";
import { formatUniverseReport, runUniverse } from "./universe";

/**
 * Phase 0 스파이크 CLI.
 *
 * 이 도구는 DB 없이 동작한다. 목적은 "코드를 쓰기 전에 숫자를 아는 것"이다.
 * 설계서 11장의 Phase -1 병렬 트랙에서 가장 먼저 실행할 명령이 `universe` 다.
 */

const HELP = `
LeadOps 스파이크 CLI

사용법:
  pnpm spike <command> [options]

명령:
  verify      어댑터를 실 API 로 검증한다  ← 실키 확보 후 가장 먼저 할 일
              엔드포인트 후보를 탐색하고, 응답 필드와 코드값을 확인하고,
              실제 응답을 fixture 로 녹화한다. 공공데이터포털 키가 필요하다.

  universe    모집단 크기(M0)와 신규 후보 소진 곡선을 산출한다
              업종당 API 호출 1회. 법률 검토를 기다릴 필요가 없다.

  sample      골드셋 라벨링용 층화 표본을 뽑아 CSV 로 저장한다

  measure     라벨링이 끝난 골드셋 CSV 로 M1~M14 를 측정하고 Phase 0 판정을 낸다
              라벨(사람) + 파이프라인 실제 출력(DB) 을 대조한다.
              ❗ 그 표본으로 파이프라인이 먼저 돌아 있어야 한다.
              ❗ 라벨이 없는 지표는 숫자 대신 '미측정' 으로 보고한다.

공통 옵션:
  --industry <derm|plastic|dental|franchise>   특정 업종만 (반복 대신 쉼표 구분)
  --out <dir>                                  출력 디렉터리 (기본 SPIKE_OUT_DIR)
  --log <debug|info|warn|error>                로그 수준 (기본 info)

sample 옵션:
  --per-industry <n>   업종당 표본 수 (기본 30)
  --pool <n>           층화 전에 읽어올 후보 수 (기본 표본수 × 10)
  --seed <n>           난수 시드 (기본 20260729). 같은 시드 → 같은 표본

verify 옵션:
  --fixtures <dir>     실제 응답을 저장할 디렉터리 (기본 fixtures/http)
  --no-record          fixture 를 저장하지 않는다

measure 옵션:
  --goldset <path>     라벨링이 끝난 CSV (필수)
  --db <dsn>           DB 접속 문자열 (기본 DATABASE_URL 환경변수)

예:
  pnpm spike verify
  pnpm spike universe
  pnpm spike universe --industry=dental,derm
  pnpm spike sample --per-industry 30 --seed 42
  pnpm spike measure --goldset out/sample-seed42.csv

공공데이터포털 키 발급:
  https://www.data.go.kr 회원가입 → 아래 3개 데이터셋에 '활용신청'
    · 건강보험심사평가원_병원정보서비스        (15001698)
    · 공정거래위원회_가맹정보_브랜드 목록      (15125467)
    · 국세청_사업자등록정보 진위확인 및 상태조회 (15081808)
  → 마이페이지에서 '일반 인증키(Encoding/Decoding)' 확인
  → .env 의 DATA_GO_KR_SERVICE_KEY 에 **Decoding 키**를 넣는다
     (Encoding 키를 넣으면 이중 인코딩되어 SERVICE_KEY_IS_NOT_REGISTERED_ERROR 가 난다)
`;

function parseIndustries(raw: string | undefined): readonly IndustryT[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: IndustryT[] = [];
  for (const p of parts) {
    const parsed = Industry.safeParse(p);
    if (!parsed.success) {
      throw new Error(`알 수 없는 업종: ${p} (가능: ${Industry.options.join(", ")})`);
    }
    out.push(parsed.data);
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === undefined || args.command === "help" || args.flags["help"] === true) {
    process.stdout.write(HELP);
    return 0;
  }

  const env = getEnv();
  const level = (flagString(args, "log") ?? "info") as "debug" | "info" | "warn" | "error";
  const logger = createLogger({ level, sink: (line) => process.stderr.write(line + "\n") });
  const industries = parseIndustries(flagString(args, "industry"));
  const outDir = flagString(args, "out");

  switch (args.command) {
    case "verify": {
      // ❗ 검증은 정의상 실 API 호출이다. mock 으로는 아무것도 증명하지 못한다.
      if (env.FEATURE_SOURCE !== "live") {
        throw configError(
          "verify 는 FEATURE_SOURCE=live 에서만 의미가 있습니다.\n" +
            "  .env 에서 FEATURE_SOURCE=live 로 바꾸고 DATA_GO_KR_SERVICE_KEY 를 넣으세요.\n" +
            "  (mock 으로 검증하면 검증한 것이 아닙니다)",
        );
      }
      if (!env.DATA_GO_KR_SERVICE_KEY) {
        throw configError("DATA_GO_KR_SERVICE_KEY 가 필요합니다. `pnpm spike help` 의 키 발급 안내를 보세요.");
      }

      const http = createHttpClient(env, { logger });
      const results = await verifyAdapters({
        http,
        serviceKey: env.DATA_GO_KR_SERVICE_KEY,
        logger,
        ...(flagBool(args, "no-record") ? {} : { fixtureDir: flagString(args, "fixtures") ?? "fixtures/http" }),
        ...(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET
          ? { naver: { clientId: env.NAVER_CLIENT_ID, clientSecret: env.NAVER_CLIENT_SECRET } }
          : {}),
      });
      process.stdout.write(formatVerification(results) + "\n");
      return results.some((r) => r.status === "fail") ? 1 : 0;
    }
    case "universe": {
      const report = await runUniverse({
        env,
        logger,
        ...(industries ? { industries } : {}),
        ...(outDir ? { outDir } : {}),
      });
      process.stdout.write(formatUniverseReport(report) + "\n");
      return 0;
    }
    case "sample": {
      const perIndustry = flagNumber(args, "per-industry");
      const poolSize = flagNumber(args, "pool");
      const seed = flagNumber(args, "seed");
      const report = await runSample({
        env,
        logger,
        ...(industries ? { industries } : {}),
        ...(perIndustry !== undefined ? { perIndustry } : {}),
        ...(poolSize !== undefined ? { poolSize } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(outDir ? { outDir } : {}),
      });
      process.stdout.write(formatSampleReport(report) + "\n");
      return 0;
    }
    case "measure": {
      const goldsetPath = flagString(args, "goldset");
      if (!goldsetPath) {
        throw configError(
          "--goldset <path> 가 필요합니다.\n" +
            "  `pnpm spike sample` 로 뽑은 CSV 의 label_* 열을 채운 파일을 지정하세요.\n" +
            "  라벨링 기준: docs/08-goldset-labeling.md",
        );
      }
      const databaseUrl = flagString(args, "db") ?? process.env["DATABASE_URL"];
      if (!databaseUrl) {
        throw configError(
          "DB 접속 정보가 필요합니다 (--db <dsn> 또는 DATABASE_URL).\n" +
            "  측정은 파이프라인이 **실제로 낸 판정**을 읽습니다 — 다시 계산하지 않습니다.",
        );
      }

      const report = await runMeasure({ goldsetPath, databaseUrl, logger });
      process.stdout.write(formatMeasureReport(report) + "\n");
      // ❗ stop 은 종료 코드 1 이다. CI·스크립트가 stdout 을 파싱하지 않아도 알 수 있어야 한다.
      //    미판정도 1 이다 — 라벨을 덜 채운 것이 성공으로 읽히면 안 된다.
      return report.verdict === "inconclusive" ? 0 : 1;
    }
    default:
      process.stderr.write(`알 수 없는 명령: ${args.command}\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof LeadOpsError) {
      process.stderr.write(`\n✗ [${err.code}] ${err.message}\n`);
      if (Object.keys(err.details).length > 0) {
        process.stderr.write(`  ${JSON.stringify(err.details)}\n`);
      }
    } else {
      process.stderr.write(`\n✗ ${(err as Error).message}\n`);
    }
    process.exitCode = 1;
  });
