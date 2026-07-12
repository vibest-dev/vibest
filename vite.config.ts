import { defineConfig } from "vite-plus";

export default defineConfig({
  // Vitest configuration for the whole workspace. `vp test` runs every
  // package project listed here. See packages/*/vitest.config.ts.
  test: {
    projects: ["packages/*/vitest.config.ts"],
  },

  // `vp check`/`vp fmt`/`vp lint` read ignore globs from these blocks (not
  // from .oxfmtrc.json/.oxlintrc.json, which vite-plus only consults for
  // `vp fmt --init`/`--migrate`). Skip the generated codex protocol bindings.
  fmt: {
    ignorePatterns: ["packages/harness/src/codex/protocol/**"],
  },
  lint: {
    ignorePatterns: ["packages/harness/src/codex/protocol/**"],
  },

  // Staged-file checks run by the Vite+ pre-commit hook (.vite-hooks).
  staged: {
    "*": "vp check --fix",
  },
});
