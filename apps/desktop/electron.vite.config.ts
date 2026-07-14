import { appAlias, appVitePlugins } from "@vibest/app/vite";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        // CommonJS: a sandboxed renderer cannot load an ESM preload.
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    // The renderer *is* apps/app, compiled from source into the Electron
    // bundle — not a copy of apps/app/dist. Same plugins, same alias.
    root: "src/renderer",
    resolve: {
      alias: appAlias(),
    },
    plugins: appVitePlugins(),
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: {
          index: "src/renderer/index.html",
        },
      },
    },
  },
});
