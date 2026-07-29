import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

/**
 * 마이그레이션 러너.
 *
 * - 파일명 사전순으로 적용한다.
 * - 각 파일은 simple query protocol 로 한 번에 보내므로 **파일 단위로 원자적**이다
 *   (Postgres 는 명시적 BEGIN 이 없는 다중 문장 simple query 를 하나의 암시적
 *    트랜잭션으로 처리한다).
 * - 적용 이력은 `_migrations` 에 남긴다.
 *
 * ❗ `0000_local_bootstrap.sql` 은 `bootstrap: true` 일 때만 적용한다.
 *    Supabase 는 auth 스키마와 역할을 이미 제공하므로 그쪽에 올리면 안 된다.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const BOOTSTRAP_FILE = "0000_local_bootstrap.sql";

export interface MigrateOptions {
  /** 로컬·테스트에서 auth 스키마와 역할을 만들지. 기본 false. */
  bootstrap?: boolean;
  onApply?: (name: string) => void;
}

export function listMigrations(bootstrap = false): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => bootstrap || f !== BOOTSTRAP_FILE)
    .sort();
}

export function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

export async function migrate(sql: Sql, options: MigrateOptions = {}): Promise<string[]> {
  await sql`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set(
    (await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name),
  );

  const done: string[] = [];
  for (const name of listMigrations(options.bootstrap ?? false)) {
    if (applied.has(name)) continue;
    await sql.unsafe(readMigration(name)).simple();
    await sql`insert into _migrations (name) values (${name})`;
    options.onApply?.(name);
    done.push(name);
  }
  return done;
}
