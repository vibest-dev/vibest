import url from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { isRunningFromAgent } from "agent-cli-detector";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { defineConfig } from "vite";

/**
 * The dev server the browser talks to. The vibest server no longer embeds Vite,
 * so this proxies the two prefixes it owns — which also keeps the app
 * same-origin with the RPC, the way it is when the server serves the built
 * bundle. Add a prefix here whenever the server grows one.
 *
 * 4180/4190 rather than 4000/5173, which are taken: 4000 is the daemon's
 * default, spawned by the desktop app and guarded by an auth token this browser
 * cannot present — proxying there answers `/api/health` but 401s the ws-ticket,
 * so the app loads and silently never connects. 5173 is `apps/desktop`'s
 * electron-vite renderer. 4180/4190 are claimed by no common dev tool. Open
 * 4190: 4180 serves the last *built* bundle, so it works but shows stale UI.
 */
const SERVER_PORT = Number(process.env.VIBEST_PORT ?? 4180);
const serverTarget = `http://127.0.0.1:${SERVER_PORT}`;
const RUNNING_IN_AGENT = isRunningFromAgent({ experimentalProcessTree: true });

export default defineConfig({
  experimental: {
    bundledDev: true,
  },
  define: {
    "import.meta.env.VIBEST_RUN_IN_AGENT": JSON.stringify(RUNNING_IN_AGENT),
  },
  server: {
    // Strict, so a taken port fails the boot instead of silently drifting to
    // the next one — that drift is how you end up reading someone else's dev
    // server at the URL you expected to be ours.
    port: 4190,
    strictPort: true,
    // Vite rejects any Host it doesn't recognise, which is every name a tunnel
    // puts in front of it (tailnet MagicDNS, ngrok, …). Opt in per run —
    // `VIBEST_ALLOWED_HOSTS=<host>[,<host>] pnpm dev` — so the default stays
    // localhost-only and nobody widens it by accident. The daemon's own
    // WebSocket guard is separate and allowlists loopback origins only, so a
    // tunnelled run also needs `VIBEST_CORS_ORIGINS=<origin>` (see http/cors.ts).
    allowedHosts: process.env.VIBEST_ALLOWED_HOSTS?.split(",").filter(Boolean),
    proxy: {
      "/api": { target: serverTarget, changeOrigin: true },
      "/ws/rpc": { target: serverTarget, changeOrigin: true, ws: true },
    },
  },
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
