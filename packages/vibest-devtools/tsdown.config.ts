import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: ["src/vite.ts"],
  format: ["esm"],
  platform: "node",
  clean: false,
  loader: {
    jsonl: "dataurl",
  },
});
