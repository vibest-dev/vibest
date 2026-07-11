import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { fileURLToPath } from "node:url";
// import vibestDevtools from "vibest-devtools/vite";
import { defineConfig } from "vite-plus";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/client", import.meta.url)),
    },
  },
  build: {
    outDir: "./dist/client",
  },
  plugins: [
    codeInspectorPlugin({ bundler: "vite" }),
    // vibestDevtools(),
    // The TanStack Router plugin must come before JSX transform plugins.
    tanstackRouter({
      target: "react",
      verboseFileRoutes: false,
      autoCodeSplitting: true,
      routesDirectory: "./src/client/routes",
      generatedRouteTree: "./src/client/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
});
