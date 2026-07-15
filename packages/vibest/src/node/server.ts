import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeRPCHandler, createRpcRuntime, createWsRPCHandler } from "@vibest/server/rpc";
import sirv from "sirv";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { bearerToken, createTicketStore, tokensMatch } from "./auth";
import { corsHeaders } from "./cors";

const isDev = process.env.NODE_ENV === "development";

type UIHandler = (req: IncomingMessage, res: ServerResponse) => void;

export type ManagedServer = Server & {
  readonly dispose: () => Promise<void>;
};

export type CreateServerOptions = {
  /**
   * When set, every `/api/*` request except `/api/health` must present
   * `Authorization: Bearer <token>`, and every WebSocket upgrade must carry a
   * valid single-use `?ticket=`. Unset (browser mode) disables both.
   */
  authToken?: string | undefined;
  /** Origins permitted to make cross-origin requests. Empty = same-origin only. */
  corsOrigins?: readonly string[] | undefined;
};

function notFound(res: ServerResponse) {
  res.statusCode = 404;
  res.end("Not Found");
}

/**
 * Locate the built web UI: the packaged layout ships it next to the server
 * bundle as `client/`, while running from monorepo source falls back to
 * `apps/app/dist`.
 */
function resolveStaticDir(): string | undefined {
  const candidates = [
    new URL("./client/", import.meta.url), // packaged: dist/client next to dist/cli.js
    new URL("../../../../apps/app/dist/", import.meta.url), // monorepo, from src/node
    new URL("../../../apps/app/dist/", import.meta.url), // monorepo, from packages/vibest/dist
  ];
  for (const candidate of candidates) {
    const dir = path.resolve(fileURLToPath(candidate));
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return undefined;
}

export async function createServer(options: CreateServerOptions = {}): Promise<ManagedServer> {
  const { authToken, corsOrigins = [] } = options;

  const rpcRuntime = await createRpcRuntime();
  const rpcHandler = createNodeRPCHandler(rpcRuntime.context);
  const wsHandler = createWsRPCHandler(rpcRuntime.context);
  const tickets = createTicketStore();

  let serveUI: UIHandler;
  let closeUI = async () => {};

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      const headers = corsHeaders(req.headers.origin, corsOrigins);
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          res.setHeader(name, value);
        }
      }

      if (req.method === "OPTIONS") {
        // A preflight from an origin we don't allow gets no headers, so the
        // browser blocks the real request that would have followed.
        res.statusCode = headers ? 204 : 403;
        res.end();
        return;
      }

      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      // Unauthenticated on purpose: the desktop supervisor polls this before
      // it holds a token, and it discloses nothing.
      if (req.method === "GET" && pathname === "/api/health") {
        res.setHeader("content-type", "text/plain");
        res.end("ok");
        return;
      }

      if (authToken !== undefined && pathname.startsWith("/api/")) {
        if (!tokensMatch(authToken, bearerToken(req.headers.authorization))) {
          res.statusCode = 401;
          res.end("Unauthorized");
          return;
        }
      }

      if (req.method === "POST" && pathname === "/api/ws-ticket") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ticket: tickets.issue() }));
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
      // Serve the standalone web app package (apps/app) through this server.
      root: path.resolve(fileURLToPath(new URL("../../../../apps/app/", import.meta.url))),
      server: {
        middlewareMode: true,
        hmr: {
          server,
        },
      },
    });
    serveUI = (req, res) => vite.middlewares(req, res, () => notFound(res));
    closeUI = () => vite.close();
  } else {
    const staticDir = resolveStaticDir();
    if (!staticDir) {
      serveUI = (_req, res) => {
        res.statusCode = 503;
        res.end("Web UI not built. Run the @vibest/app build first.");
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

    if (authToken !== undefined) {
      // A WS handshake carries no Authorization header, so the renderer proves
      // itself with a single-use ticket minted over the authenticated HTTP link.
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (!tickets.consume(requestUrl.searchParams.get("ticket"))) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  });

  let disposing: Promise<void> | undefined;
  const dispose = () =>
    (disposing ??= (async () => {
      const serverClosed = server.listening
        ? new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          })
        : Promise.resolve();

      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await serverClosed;
      await closeUI();
      await rpcRuntime.dispose();
    })());

  server.once("close", () => {
    void dispose();
  });

  return Object.assign(server, { dispose });
}
