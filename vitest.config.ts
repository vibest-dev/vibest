import { defineConfig } from "vitest/config"

export default defineConfig({
  ssr: { resolve: { conditions: ["bun", "import", "default"] } },
  test: {
    globalSetup: ["./vitest.globalSetup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "packages/cli/test/**/*.test.ts",
      "packages/integration/claude/test/**/*.test.ts",
      "packages/effect-herdr-sdk/test/**/*.test.ts",
      "packages/effect-herdr-core-sdk/test/**/*.test.ts",
      "packages/runtime-herdr-core/test/**/*.test.ts",
      "packages/integration/pi/test/**/*.test.ts",
      "packages/integration/cursor/test/**/*.test.ts",
      "packages/schema/test/**/*.test.ts",
      "packages/core/src/**/*.test.ts",
      "packages/core/test/**/*.test.ts",
      "packages/plugin-harnesses/test/**/*.test.ts",
      "packages/plugin/test/**/*.test.ts",
      "tools/oxlint/**/*.test.mjs",
    ],
    fileParallelism: true,
    maxConcurrency: 8,
    testTimeout: 30_000,
  },
})
