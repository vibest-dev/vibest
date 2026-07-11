import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: ["src/node/cli.ts"],
  platform: "node",
  external: ["vite"],
  clean: false,
  env: {
    NODE_ENV: "production",
  },
});
