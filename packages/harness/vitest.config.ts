import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.json",
    },
  },
});
