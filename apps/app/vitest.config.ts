import url from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": url.fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
