import { defineConfig } from "vitest/config";
import { alias } from "./vitest.config";

/**
 * 실제 Postgres 가 필요한 통합 테스트.
 *
 *   pnpm db:up && pnpm test:db
 *
 * RLS·plpgsql·행 잠금·복합 FK 는 흉내 낼 수 없고, 흉내 낸 것으로 통과시키면
 * 검증한 것이 아니므로 진짜 Postgres 를 쓴다.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.pg.test.ts", "apps/*/src/**/*.pg.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 각 파일이 자기 데이터베이스를 만들지만, 동시 승인 테스트가 시계에 민감하므로
    // 파일 단위 병렬만 허용하고 파일 내부는 순차 실행한다.
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
