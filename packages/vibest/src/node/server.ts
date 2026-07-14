import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeRPCHandler, createWsRPCHandler } from "@vibest/server/rpc";
import sirv from "sirv";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

const isDev = process.env.NODE_ENV === "development";

type UIHandler = (req: IncomingMessage, res: ServerResponse) => void;

function notFound(res: ServerResponse) {
  res.statusCode = 404;
  res.end("Not Found");
}

/**
 * Locate the built web UI (t3code-style): the packaged layout ships it next
 * to the server bundle as `client/`, while running from monorepo source falls
 * back to `apps/web/dist`.
 */
function resolveStaticDir(): string | undefined {
  const candidates = [
    new URL("./client/", import.meta.url), // packaged: dist/client next to dist/cli.js
    new URL("../../../../apps/web/dist/", import.meta.url), // monorepo, from src/node
    new URL("../../../apps/web/dist/", import.meta.url), // monorepo, from packages/vibest/dist
  ];
  for (const candidate of candidates) {
    const dir = path.resolve(fileURLToPath(candidate));
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return undefined;
}

export async function createServer(): Promise<Server> {
  const rpcHandler = createNodeRPCHandler();
  const wsHandler = createWsRPCHandler();

  let serveUI: UIHandler;

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      if (req.method === "GET" && pathname === "/api/health") {
        res.setHeader("content-type", "text/plain");
        res.end("ok");
        return;
      }

      if (pathname === "/api/rpc" || pathname.startsWith("/api/rpc/")) {
        const { matched } = await rpcHandler(req, res, {
          prefix: "/api/rpc",
        });
        if (matched) {
          return;
        }
      }

      serveUI(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    }
  }

  if (isDev) {
    // Import vite lazily so the production bundle never depends on it
    // (vite is a devDependency and marked external in tsdown.config.ts).
    const { createServer: createViteDevServer } = await import("vite");
    const vite = await createViteDevServer({
      // Serve the standalone web app package (apps/web) through this server.
      root: path.resolve(fileURLToPath(new URL("../../../../apps/web/", import.meta.url))),
      server: {
        middlewareMode: true,
        hmr: {
          server,
        },
      },
    });
    serveUI = (req, res) => vite.middlewares(req, res, () => notFound(res));
  } else {
    const staticDir = resolveStaticDir();
    if (!staticDir) {
      serveUI = (_req, res) => {
        res.statusCode = 503;
        res.end("Web UI not built. Run the @vibest/web build first.");
      };
    } else {
      const assets = sirv(staticDir, {
        single: true,
      });
      serveUI = (req, res) => assets(req, res, () => notFound(res));
    }
  }

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    wsHandler(ws);
  });
  wss.on("error", (e: Error & { code: string; port: number }) => {
    console.error(e);
  });

  // Share the same HTTP server between Vite's HMR socket and our custom WebSocketServer.
  server.on("upgrade", (req, socket, head) => {
    if (isDev) {
      const protocol = req.headers["sec-websocket-protocol"];
      if (protocol && ["vite-ping", "vite-hmr"].includes(protocol)) return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  });

  return server;
}
