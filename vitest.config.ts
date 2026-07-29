import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const alias = {
  "@leadops/core": r("./packages/core/src/index.ts"),
  "@leadops/http": r("./packages/http/src/index.ts"),
  "@leadops/adapters": r("./packages/adapters/src/index.ts"),
  "@leadops/db": r("./packages/db/src/index.ts"),
  "@leadops/pipeline": r("./packages/pipeline/src/index.ts"),
  "@leadops/worker": r("./apps/worker/src/loop.ts"),
};

// 기본 스위트 = 단위·통합 테스트. 실제 Postgres 가 필요한 `*.pg.test.ts` 는 제외한다
// (vitest.pg.config.ts 에서 `pnpm test:db` 로 따로 돌린다).
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.pg.test.ts"],
    testTimeout: 15_000,
  },
});
