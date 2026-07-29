import postgres, { type Sql } from "postgres";
import { migrate } from "./migrate";

/**
 * 통합 테스트용 Postgres 하네스.
 *
 * 실제 Postgres 를 쓴다. RLS·plpgsql·행 잠금·citext 는 흉내 낼 수 없고,
 * 흉내 낸 것으로 통과시키면 검증한 것이 아니기 때문이다.
 *
 *   pnpm db:up      # 컨테이너 기동
 *   pnpm test:db    # 이 하네스를 쓰는 테스트
 */

export const DEFAULT_ADMIN_URL =
  process.env["LEADOPS_TEST_DATABASE_URL"] ?? "postgres://postgres:leadops@127.0.0.1:55432/postgres";

export interface TestDb {
  /** 소유자 연결. 마이그레이션과 fixture 준비에 쓴다. RLS 를 우회한다. */
  owner: Sql;
  /** 데이터베이스 이름. */
  name: string;
  /** 지정한 사용자로 인증된 세션에서 실행한다. RLS 가 적용된다. */
  asUser<T>(userId: string, fn: (tx: Sql) => Promise<T>): Promise<T>;
  /** 익명(비로그인) 세션에서 실행한다. */
  asAnon<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  /** 워커 역할로 실행한다 (트랜잭션 안, SET ROLE). */
  asWorker<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  /**
   * ❗ 실제 `leadops_worker` 권한으로 로그인한 **별도 커넥션**.
   *
   * `asWorker` 는 트랜잭션 안에서 SET ROLE 을 쓰므로 워커 루프처럼 여러 문장을
   * autocommit 으로 실행하는 코드에는 맞지 않는다. E2E 는 진짜 접속을 써야
   * 권한 모델까지 함께 검증된다.
   */
  workerSql: Sql;
  close(): Promise<void>;
}

export async function isPostgresAvailable(url = DEFAULT_ADMIN_URL): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** 격리된 데이터베이스를 만들고 마이그레이션을 적용한다. */
export async function createTestDb(label: string, adminUrl = DEFAULT_ADMIN_URL): Promise<TestDb> {
  const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const name = `leadops_t_${label}_${suffix}`.toLowerCase().slice(0, 60);

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const owner = postgres(url.href, { max: 5, onnotice: () => {} });

  await migrate(owner, { bootstrap: true });

  // 워커 전용 로그인 역할. leadops_worker 의 권한만 상속받는다.
  const workerRole = `${name}_w`.slice(0, 60);
  const workerPassword = "test-worker-pw";
  await owner.unsafe(
    `create role "${workerRole}" login password '${workerPassword}' in role leadops_worker`,
  );
  await owner.unsafe(`grant connect on database "${name}" to "${workerRole}"`);

  const workerUrl = new URL(adminUrl);
  workerUrl.pathname = `/${name}`;
  workerUrl.username = workerRole;
  workerUrl.password = workerPassword;
  const workerSql = postgres(workerUrl.href, { max: 3, onnotice: () => {} });

  const runAs = async <T>(role: string, userId: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> =>
    owner.begin(async (tx) => {
      // PostgREST 와 같은 방식: 역할을 바꾸고 JWT 클레임을 세션 설정으로 넣는다.
      if (userId !== null) {
        await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
      } else {
        await tx`select set_config('request.jwt.claim.sub', '', true)`;
      }
      await tx.unsafe(`set local role ${role}`);
      return fn(tx as unknown as Sql);
    }) as Promise<T>;

  return {
    owner,
    workerSql,
    name,
    asUser: (userId, fn) => runAs("authenticated", userId, fn),
    asAnon: (fn) => runAs("anon", null, fn),
    asWorker: (fn) => runAs("leadops_worker", null, fn),
    async close() {
      await workerSql.end({ timeout: 5 });
      await owner.end({ timeout: 5 });
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
        // 역할은 클러스터 전역이므로 반드시 정리한다.
        await cleanup.unsafe(`drop role if exists "${workerRole}"`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}

/** 테스트용 사용자를 만든다. auth.users 트리거가 profiles 를 자동 생성한다. */
export async function createUser(db: TestDb, email: string, role: "admin" | "user"): Promise<string> {
  const [row] = await db.owner<{ id: string }[]>`
    insert into auth.users (email) values (${email}) returning id
  `;
  const id = row!.id;
  await db.owner`update profiles set role = ${role}::user_role where id = ${id}`;
  return id;
}
