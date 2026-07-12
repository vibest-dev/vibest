import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp pack` reads tsdown settings from this block (tsdown.config.ts is
  // ignored by vp). Keep `vite` external: server.ts imports it lazily in dev
  // only, and it must never end up in the production bundle.
  pack: {
    entry: ["src/node/cli.ts"],
    platform: "node",
    external: ["vite"],
    dts: false,
    clean: false,
    env: {
      NODE_ENV: "production",
    },
  },
});
