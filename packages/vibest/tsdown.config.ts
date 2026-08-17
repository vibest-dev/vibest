import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/node/cli.ts"],
  platform: "node",
  deps: {
    // The private server/harness/contract packages are compiled into the CLI.
    // Whitelist their bundled runtime dependencies so additions fail closed.
    // Native addons (node-pty) stay a CLI production dep and are externalized.
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
