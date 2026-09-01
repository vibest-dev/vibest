import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/node/cli.ts"],
  platform: "node",
  deps: {
    // The private server/harness/contract packages are compiled into the CLI.
    // Whitelist their bundled runtime dependencies so additions fail closed.
    // `simple-git` (and its tree) is pulled in by GitService on the serve path.
    // Native addons (node-pty) stay a CLI production dep and are externalized.
    onlyBundle: [
      "effect",
      "@effect/platform-node-shared",
      "@effect/platform-node",
      "@standardserver/shared",
      "@orpc/experimental-effect",
      "simple-git",
      /^@simple-git\//,
      /^@kwsites\//,
      "debug",
      "ms",
      "supports-color",
      "has-flag",
    ],
  },
  dts: false,
  clean: false,
  env: {
    NODE_ENV: "production",
  },
});
