import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Spawn + readiness tests (daemon launcher, harness transports) share this
    // runner with turbo's parallel build/typecheck. Vitest's 5s default is too
    // tight under that load, and `@effect/vitest` `layer({ timeout })` only
    // covers hooks — not `it.effect`.
    testTimeout: 30_000,
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.json",
    },
  },
});
