import url from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

// The dev overlays (react-grab, react-scan) reach outside the origin on boot,
// which the shipped CSP rejects with console errors on every `electron-vite dev`.
// Production builds eliminate both overlays, so index.html stays strict and the
// origins they need are spliced in for the dev server only. Each entry is
// [exact substring of the shipped policy, its dev replacement].
const DEV_CSP_PATCHES: ReadonlyArray<readonly [string, string]> = [
  // react-grab's overlay @imports Geist from Google Fonts inside its shadow root.
  // The stylesheet's own @font-face points at gstatic, and the strict policy has
  // no font-src at all, so that directive has to be spelled out — including
  // 'self', which the bundled @fontsource faces rely on.
  [
    "style-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com",
  ],
  // Deliberately NOT relaxed: both overlays fetch react-grab.com/api/version at
  // startup to nag about outdated versions, and react-grab exposes no opt-out.
  // `connect-src` blocking it is the opt-out, so its four console errors per dev
  // boot are the accepted price of not phoning home. Do not add that origin.
];

/** `apply: "serve"` keeps the built index.html byte-identical to the source. */
function devOverlayCsp(): Plugin {
  return {
    name: "vibest:dev-overlay-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return DEV_CSP_PATCHES.reduce((patched, [anchor, replacement]) => {
        if (!patched.includes(anchor)) {
          throw new Error(
            `dev CSP relaxation found no \`${anchor}\` in the renderer HTML — reconcile ` +
              "it with src/renderer/index.html, or drop the entry if the dev overlay " +
              "no longer needs that origin.",
          );
        }
        return patched.replace(anchor, replacement);
      }, html);
    },
  };
}

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
    root: url.fileURLToPath(new URL("./src/renderer/", import.meta.url)),
    resolve: {
      alias: { "@": url.fileURLToPath(new URL("../app/src/", import.meta.url)) },
    },
    plugins: [
      devOverlayCsp(),
      codeInspectorPlugin({ bundler: "vite" }),
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: url.fileURLToPath(new URL("../app/src/routes/", import.meta.url)),
        generatedRouteTree: url.fileURLToPath(
          new URL("../app/src/routeTree.gen.ts", import.meta.url),
        ),
      }),
      react(),
      tailwindcss(),
    ],
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: {
          index: url.fileURLToPath(new URL("./src/renderer/index.html", import.meta.url)),
        },
      },
    },
  },
});
