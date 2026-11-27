import { defineConfig } from "vitest/config"

export default defineConfig({
  ssr: { resolve: { conditions: ["bun", "import", "default"] } },
  test: {
    globalSetup: ["./vitest.globalSetup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "packages/*/test/**/*.test.ts",
      "tools/eval/test/**/*.test.ts",
      "tools/oxlint/**/*.test.mjs",
      "apps/vibest-herdr-app/*.test.ts",
      "apps/vibest-herdr-app/src/mods/*/*.test.ts",
      "apps/vibest-herdr-app/src/shared/*.test.ts",
    ],
    fileParallelism: true,
    maxConcurrency: 8,
    testTimeout: 30_000,
  },
})
