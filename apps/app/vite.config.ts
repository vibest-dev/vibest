import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { defineConfig } from "vite";

/**
 * The dev server the browser talks to. The vibest server no longer embeds Vite,
 * so this proxies the two prefixes it owns — which also keeps the app
 * same-origin with the RPC, the way it is when the server serves the built
 * bundle. Add a prefix here whenever the server grows one.
 */
const SERVER_PORT = Number(process.env.VIBEST_PORT ?? 4000);
const serverTarget = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  server: {
    proxy: {
      "/api": { target: serverTarget, changeOrigin: true },
      "/ws/rpc": { target: serverTarget, changeOrigin: true, ws: true },
    },
  },
  resolve: {
    tsconfigPaths: true,
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    codeInspectorPlugin({ bundler: "vite" }),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: fileURLToPath(new URL("./src/routes", import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL("./src/routeTree.gen.ts", import.meta.url)),
    }),
    react(),
    tailwindcss(),
  ],
});
