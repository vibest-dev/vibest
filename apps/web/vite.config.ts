import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    codeInspectorPlugin({ bundler: "vite" }),
    // The TanStack Router plugin must come before JSX transform plugins.
    tanstackRouter({
      target: "react",
      verboseFileRoutes: false,
      autoCodeSplitting: true,
      // Absolute paths: tools (oxfmt/oxlint) load this config with cwd at the
      // repo root, where plugin-relative paths would resolve incorrectly.
      routesDirectory: fileURLToPath(new URL("./src/routes", import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL("./src/routeTree.gen.ts", import.meta.url)),
    }),
    react(),
    tailwindcss(),
  ],
});
