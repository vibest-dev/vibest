import { defineConfig } from "vitest/config"

export default defineConfig({
  ssr: { resolve: { conditions: ["bun", "import", "default"] } },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "apps/vibest-herdr/test/**/*.test.ts",
      "packages/integration/claude/test/**/*.test.ts",
      "packages/effect-herdr-sdk/test/**/*.test.ts",
      "packages/effect-herdr-core-sdk/test/**/*.test.ts",
      "packages/runtime-herdr-core/test/**/*.test.ts",
      "packages/integration/pi/test/**/*.test.ts",
      "packages/integration/cursor/test/**/*.test.ts",
      "packages/core/src/**/*.test.ts",
      "packages/core/test/**/*.test.ts",
      "packages/plugin-harness-choice/test/**/*.test.ts",
      "apps/vibest-herdr-app/*.test.ts",
      "apps/vibest-herdr-app/src/mods/*/*.test.ts",
      "apps/vibest-herdr-app/src/shared/*.test.ts",
      "tools/oxlint/**/*.test.mjs",
      "tools/check/**/*.test.ts",
    ],
    fileParallelism: true,
    maxConcurrency: 8,
    testTimeout: 30_000,
  },
})
