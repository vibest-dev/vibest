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
 *
 * 4100, not the server's own default of 4000: that port belongs to the daemon,
 * which the desktop app spawns and which holds an auth token this browser
 * cannot present. Proxying there answers `/api/health` but 401s the ws-ticket,
 * so the app loads and never connects. Keep dev on a port nothing else claims.
 */
const SERVER_PORT = Number(process.env.VIBEST_PORT ?? 4100);
const serverTarget = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  server: {
    // Pinned, and strict: 5173 is `apps/desktop`'s electron-vite renderer, so
    // under `pnpm dev` Vite's default would silently land on 5174 — and whoever
    // opened 5173 would get the desktop renderer, which has no proxy and never
    // connects. Fail to boot instead of drifting to another port.
    port: 5180,
    strictPort: true,
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
