#!/usr/bin/env node
import postgres from "postgres";
import { listMigrations, migrate } from "./migrate";

/**
 * 마이그레이션 CLI.
 *
 *   pnpm db:migrate                      DATABASE_URL 에 적용
 *   pnpm db:migrate --bootstrap          로컬 전용 역할·auth 스텁까지 적용
 *   pnpm db:migrate --list               적용할 파일 목록만 출력
 *
 * ❗ `--bootstrap` 은 **로컬·테스트 전용**이다. Supabase 는 auth 스키마와 역할을
 *    이미 제공하므로 그쪽에 올리면 인증 구현을 덮어쓸 수 있다.
 */

const HELP = `
LeadOps 마이그레이션

사용법:
  pnpm db:migrate [--bootstrap] [--list] [--url <dsn>]

옵션:
  --bootstrap   로컬 Postgres 용 역할(anon/authenticated/leadops_worker)과
                auth 스키마 스텁을 함께 적용한다. Supabase 에는 쓰지 말 것.
  --list        적용 대상 파일만 출력하고 종료
  --url <dsn>   DATABASE_URL 대신 사용할 접속 문자열
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const bootstrap = argv.includes("--bootstrap");

  if (argv.includes("--list")) {
    for (const name of listMigrations(bootstrap)) process.stdout.write(`  ${name}\n`);
    return 0;
  }

  const urlFlag = argv.indexOf("--url");
  const dsn = urlFlag >= 0 ? argv[urlFlag + 1] : process.env["DATABASE_URL"];
  if (!dsn) {
    process.stderr.write("✗ DATABASE_URL 이 필요합니다 (또는 --url <dsn>)\n");
    return 1;
  }

  const sql = postgres(dsn, { max: 1, onnotice: () => {} });
  try {
    const applied = await migrate(sql, {
      bootstrap,
      onApply: (name) => process.stdout.write(`  ✓ ${name}\n`),
    });
    process.stdout.write(
      applied.length === 0 ? "\n이미 최신 상태입니다.\n\n" : `\n${applied.length}개 적용 완료.\n\n`,
    );
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`\n✗ ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
