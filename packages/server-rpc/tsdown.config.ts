import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: ["./src/**/*.ts"],
  format: "esm",
  dts: true,
  unbundle: true,
});
