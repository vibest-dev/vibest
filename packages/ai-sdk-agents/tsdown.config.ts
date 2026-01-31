import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/claude-code/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  unbundle: true,
  sourcemap: true,
  publint: true,
});
