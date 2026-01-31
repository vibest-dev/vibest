import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "esnext",
  platform: "browser",
  publint: true,
  exports: false,
  unbundle: true,
  alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
  },
});
