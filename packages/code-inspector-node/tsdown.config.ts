import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/*.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  platform: "browser",
  publint: true,
  unbundle: true,
});
