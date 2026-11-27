import { defineConfig } from "vitest/config"

export default defineConfig({
  ssr: { resolve: { conditions: ["bun", "import", "default"] } },
  test: {
    globalSetup: ["./vitest.globalSetup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    include: ["packages/*/test/**/*.test.ts", "tools/eval/test/**/*.test.ts", "tools/oxlint/**/*.test.mjs"],
    fileParallelism: true,
    maxConcurrency: 8,
    testTimeout: 30_000,
  },
})
