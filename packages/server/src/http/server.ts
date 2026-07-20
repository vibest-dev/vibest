import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";

import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { createRpcRuntime, createWsRPCHandler } from "../rpc";
import { bearerToken, createTicketStore, tokensMatch } from "./auth";
import { corsHeaders, isAllowedOrigin, isLoopbackHost } from "./cors";
import { createUIHandler, type UIHandler } from "./ui";

const isDev = process.env.NODE_ENV === "development";

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
  /**
   * Extra cross-origin allowlist entries on top of the built-in trusted set
   * (the desktop scheme + loopback). For a future hosted web app; unset in the
   * common case, where the static policy already covers every real client.
   */
  corsOrigins?: readonly string[] | undefined;
};

function notFound(res: ServerResponse) {
  res.statusCode = 404;
  res.end("Not Found");
}

export async function createServer(options: CreateServerOptions = {}): Promise<ManagedServer> {
  const { authToken, corsOrigins = [] } = options;

  const rpcRuntime = await createRpcRuntime();
  const wsHandler = createWsRPCHandler(rpcRuntime.context);
  const tickets = createTicketStore();

  let serveUI: UIHandler;
  let closeUI = async () => {};

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      // Anti DNS-rebinding: the server binds loopback, so a request whose Host
      // is not loopback comes from an attacker page whose domain rebound to
      // 127.0.0.1 — CORS would not stop it, this does.
      if (!isLoopbackHost(req.headers.host)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }

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

      if (pathname.startsWith("/api/")) {
        notFound(res);
        return;
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

  ({ serveUI, closeUI } = await createUIHandler(server, isDev));

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

    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (requestUrl.pathname !== "/ws/rpc") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // CORS never guards WebSockets, so the upgrade repeats the HTTP checks:
    // reject a rebinding Host and any browser Origin outside the allowlist.
    // A native client (no Origin) still passes, gated only by the ticket below.
    const origin = req.headers.origin;
    if (
      !isLoopbackHost(req.headers.host) ||
      (origin !== undefined && !isAllowedOrigin(origin, corsOrigins))
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (authToken !== undefined) {
      // A WS handshake carries no Authorization header, so the renderer proves
      // itself with a single-use ticket minted over the authenticated HTTP link.
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
