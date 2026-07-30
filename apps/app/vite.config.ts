import url from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: { "@": url.fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    codeInspectorPlugin({ bundler: "vite" }),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: url.fileURLToPath(new URL("./src/routes", import.meta.url)),
      generatedRouteTree: url.fileURLToPath(new URL("./src/routeTree.gen.ts", import.meta.url)),
    }),
    react(),
    tailwindcss(),
  ],
});
