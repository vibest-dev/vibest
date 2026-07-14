import { defineConfig } from "tsdown";

export default defineConfig({
  // Keep `vite` external: server.ts imports it lazily in dev only, and it must
  // never end up in the production bundle.
  entry: ["src/node/cli.ts"],
  platform: "node",
  external: ["vite"],
  dts: false,
  clean: false,
  env: {
    NODE_ENV: "production",
  },
});
