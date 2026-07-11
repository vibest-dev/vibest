import { defineConfig } from "vite-plus";

export default defineConfig({
  // Vitest configuration for the whole workspace. `vp test` runs every
  // package project listed here. See packages/*/vitest.config.ts.
  test: {
    projects: ["packages/*/vitest.config.ts"],
  },

  // Staged-file checks run by the Vite+ pre-commit hook (.vite-hooks).
  staged: {
    "*": "vp check --fix",
  },
});
