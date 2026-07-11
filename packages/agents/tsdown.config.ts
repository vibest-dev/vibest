import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: ["./src/**/*.ts"],
  dts: true,
  unbundle: true,
  target: "node18",
});
