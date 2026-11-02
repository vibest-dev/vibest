// Tests run under Bun (`pnpm run test`): `#platform` resolves through the "bun" condition to the Bun layers.
import { defineConfig } from "vitest/config"

export default defineConfig({
  ssr: { resolve: { conditions: ["bun", "import", "default"] } },
  test: {
    include: [
      "apps/vibest-herdr/test/**/*.test.ts",
      "packages/integration/claude/test/**/*.test.ts",
      "packages/effect-herdr-sdk/test/**/*.test.ts",
      "packages/integration/pi/test/**/*.test.ts",
      "packages/integration/cursor/test/**/*.test.ts",
      "packages/core/src/**/*.test.ts",
      "tools/oxlint/**/*.test.mjs",
    ],
    // Within a file, concurrent tests share one worker. 5s is too tight once several git or bun tests overlap.
    fileParallelism: true,
    maxConcurrency: 8,
    testTimeout: 30_000,
  },
})
