import { defineConfig } from "vitest/config"

export default defineConfig({
  ssr: { resolve: { conditions: ["bun", "import", "default"] } },
  test: {
    globalSetup: ["./vitest.globalSetup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "packages/cli/test/**/*.test.ts",
      "packages/platform-bun/test/**/*.test.ts",
      "packages/harness-claude/test/**/*.test.ts",
      "packages/herdr-sdk/test/**/*.test.ts",
      "packages/herdr-core-sdk/test/**/*.test.ts",
      "packages/runtime-herdr-core/test/**/*.test.ts",
      "packages/runtime-rex/test/**/*.test.ts",
      "packages/harness-pi/test/**/*.test.ts",
      "packages/harness-cursor/test/**/*.test.ts",
      "packages/harness-agy/test/**/*.test.ts",
      "packages/schema/test/**/*.test.ts",
      "packages/util/test/**/*.test.ts",
      "packages/core/src/**/*.test.ts",
      "packages/core/test/**/*.test.ts",
      "packages/plugin-harnesses/test/**/*.test.ts",
      "packages/plugin/test/**/*.test.ts",
      "packages/plugin-builtins/test/**/*.test.ts",
      "packages/plugin-*/test/**/*.test.ts",
      "tools/oxlint/**/*.test.mjs",
    ],
    fileParallelism: true,
    maxConcurrency: 8,
    testTimeout: 30_000,
  },
})
