import url from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": url.fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
