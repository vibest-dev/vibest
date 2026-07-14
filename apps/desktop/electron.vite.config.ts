import { appAlias, appVitePlugins } from "@vibest/app/vite";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      // electron-vite externalizes every production dependency by default, but
      // `@vibest/cli/handshake` resolves to TypeScript source and so must be
      // compiled into the main bundle. Left external, the packaged app imports
      // it at runtime from inside the asar's node_modules, where Node refuses
      // to strip types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
      // Unpackaged runs get away with it only because pnpm's symlink puts the
      // real file outside node_modules.
      externalizeDeps: {
        exclude: ["@vibest/cli"],
      },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        // A sandboxed renderer receives the MessagePort through a CommonJS preload.
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
