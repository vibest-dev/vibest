import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.test.json",
    },
  },
});
