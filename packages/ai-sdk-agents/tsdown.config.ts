import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: ["src/index.ts", "src/claude-code/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  unbundle: true,
  sourcemap: true,
  publint: true,
});
