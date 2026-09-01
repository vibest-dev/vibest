import { defineConfig } from "tsdown";

export default defineConfig({
  // The forkable server bundle. Emitted as `dist/server.mjs` (object entry key
  // → output name) so the desktop supervisor and the daemon launcher can spawn
  // a single self-contained file.
  entry: { server: "src/http/main.ts" },
  platform: "node",
  format: ["esm"],
  deps: {
    // Inline everything so the forked artifact needs no node_modules resolution.
    // `vite` is the exception: server.ts imports it lazily only in dev, and the
    // `NODE_ENV=production` define below dead-code-eliminates that branch.
    // `node-pty` is a native addon (plus spawn-helper); bundling it breaks
    // the .node load and the helper path lookup.
    alwaysBundle: [/.*/],
    neverBundle: ["vite", "node-pty"],
    onlyBundle: false,
  },
  dts: false,
  clean: false,
  shims: true,
  env: {
    NODE_ENV: "production",
  },
});
