import { defineConfig } from "vite";

import { appAlias, appVitePlugins } from "./vite.shared";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: appAlias(),
  },
  plugins: appVitePlugins(),
});
