import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/**/*.ts"],
  dts: true,
  unbundle: true,
  target: "node18",
});
