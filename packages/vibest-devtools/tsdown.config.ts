import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/vite.ts"],
  format: ["esm"],
  platform: "node",
  clean: false,
  loader: {
    jsonl: "dataurl",
  },
});
