import type { Sql } from "postgres";

/**
 * 요청별 DB 세션 (설계서 6.3 권한 모델).
 *
 * API 는 **하나의 권한 있는 접속**을 쓰고, 사용자 작업마다 트랜잭션 안에서
 * `authenticated` 역할로 내려간 뒤 JWT 의 `sub` 를 세션 설정으로 넣는다.
 * PostgREST 가 하는 것과 같은 방식이고, `auth.uid()` 와 RLS 가 그대로 동작한다.
 *
 * ❗ **왜 사용자별 접속을 쓰지 않는가**: 요청마다 커넥션을 만들면 풀이 무의미해지고,
 *    Supabase 에서는 사용자별 DB 로그인이 아예 존재하지 않는다.
 *
 * ❗ **왜 권한을 내려야 하는가**: 내리지 않으면 소유자 권한으로 질의하게 되고 RLS 가
 *    적용되지 않는다. 그러면 "인증 사용자는 어떤 테이블에도 직접 쓸 수 없다" 는
 *    보장이 API 를 통과하는 순간 사라진다.
 */
export class Session {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /**
   * 사용자 컨텍스트로 실행한다. RLS 가 적용된다.
   *
   * `set local` 이므로 트랜잭션이 끝나면 역할과 클레임이 자동으로 되돌아간다 —
   * 커넥션이 풀로 반납될 때 권한이 남지 않는다.
   */
  async asUser<T>(userId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return this.#sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
      await tx.unsafe("set local role authenticated");
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }

  /**
   * admin 인지 DB 에 물어본다.
   *
   * ❗ JWT 의 `role` 클레임을 믿지 않는다. 그것은 Supabase 의 DB 역할(`authenticated`)이고
   *    우리 앱 권한(`profiles.role`)이 아니다. 클라이언트가 만든 토큰의 클레임으로 관리자
   *    여부를 판단하면 안 된다 — 진실은 `profiles` 에 있다.
   *
   * 쓰기 RPC 는 스스로 `is_admin()` 을 다시 검사한다. 여기서 미리 보는 이유는 API 를 우회한
   * 호출까지 막으려는 것이 아니라, 거절 사유를 403 으로 정확히 알려 주기 위해서다.
   */
  async isAdmin(userId: string): Promise<boolean> {
    const rows = await this.asUser(userId, (tx) => tx<Array<{ is_admin: boolean }>>`
      select public.is_admin()
    `);
    return rows[0]?.is_admin === true;
  }

  /**
   * 서버 권한으로, **트랜잭션으로 감싸지 않고** 실행한다.
   *
   * ❗ 스스로 트랜잭션을 여는 코드에만 쓴다 — 파이프라인의 `startRun` 이 그렇다.
   *    postgres.js 의 트랜잭션 객체에는 `begin` 이 없어서 중첩하면 런타임에 깨진다.
   *
   * ❗ 여기서는 `auth.uid()` 가 비어 있다. 세션 설정을 트랜잭션 밖에 남기면 커넥션이 풀로
   *    돌아간 뒤에도 남을 수 있어서 넣지 않는다. 행위자를 남겨야 하는 쓰기는 별도로
   *    `privileged(actorId, …)` 로 처리한다.
   */
  async serverWide<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    return fn(this.#sql);
  }

  /**
   * 서버 권한으로 트랜잭션 안에서 실행한다.
   *
   * ❗ 사용자가 위조하면 안 되는 쓰기에만 쓴다. 현재 용도는 **MX 검증 결과 기록**
   *    (마이그레이션 0010 — `authenticated` 에게 주면 검수자가 스스로 승인 게이트를
   *    통과시킬 수 있다)과, 파이프라인이 직접 만든 실행의 **감사 로그 기록**이다.
   *
   * `auth.uid()` 가 필요하면 행위자를 함께 넘긴다. 감사 로그에 누가 시켰는지 남아야 한다.
   */
  async privileged<T>(actorId: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return this.#sql.begin(async (tx) => {
      if (actorId) await tx`select set_config('request.jwt.claim.sub', ${actorId}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }
}
