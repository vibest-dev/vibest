import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      // electron-vite externalizes every production dependency by default, but
      // `@vibest/server/daemon` resolves to TypeScript source and so must be
      // compiled into the main bundle. Left external, the packaged app imports
      // it at runtime from inside the asar's node_modules, where Node refuses
      // to strip types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
      // Unpackaged runs get away with it only because pnpm's symlink puts the
      // real file outside node_modules.
      externalizeDeps: {
        exclude: ["@vibest/server"],
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
    root: fileURLToPath(new URL("./src/renderer/", import.meta.url)),
    resolve: {
      alias: { "@": fileURLToPath(new URL("../app/src/", import.meta.url)) },
    },
    plugins: [
      codeInspectorPlugin({ bundler: "vite" }),
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: fileURLToPath(new URL("../app/src/routes/", import.meta.url)),
        generatedRouteTree: fileURLToPath(new URL("../app/src/routeTree.gen.ts", import.meta.url)),
      }),
      react(),
      tailwindcss(),
    ],
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL("./src/renderer/index.html", import.meta.url)),
        },
      },
    },
  },
});
