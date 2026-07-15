import { defineConfig } from "tsdown";

export default defineConfig({
  // Keep `vite` external: server.ts imports it lazily in dev only, and it must
  // never end up in the production bundle.
  entry: ["src/node/cli.ts"],
  platform: "node",
  deps: {
    neverBundle: ["vite"],
    // The private server/harness/contract packages are compiled into the CLI.
    // Whitelist their bundled runtime dependencies so additions fail closed.
    onlyBundle: [
      "effect",
      "@effect/platform-node-shared",
      "@effect/platform-node",
      "@standardserver/shared",
      "@orpc/experimental-effect",
    ],
  },
  dts: false,
  clean: false,
  env: {
    NODE_ENV: "production",
  },
});
