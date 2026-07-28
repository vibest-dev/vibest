import type { Server } from "node:http";
import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Exit, Scope } from "effect";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { createRpcRuntime, createWsRPCHandler } from "../rpc";
import { makeRequestApp } from "./app";
import { createTicketStore } from "./auth";
import { isAllowedOrigin, isLoopbackHost } from "./cors";
import { createUIHandler } from "./ui";

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

export async function createServer(options: CreateServerOptions = {}): Promise<ManagedServer> {
  const { authToken, corsOrigins = [] } = options;

  const rpcRuntime = await createRpcRuntime();
  const wsHandler = createWsRPCHandler(rpcRuntime.context);
  const tickets = createTicketStore();

  const server = http.createServer();

  // The request half is Effect-native and runs on the RPC runtime, which
  // already carries FileSystem/Path/HttpPlatform. `makeHandler` gives back a
  // plain node `request` listener, which is the whole point: it leaves the
  // `upgrade` event below untouched. (`HttpServer.serve` would register its own
  // upgrade handler and fight oRPC for it.)
  const ui = await rpcRuntime.run(createUIHandler());
  const requestScope = Scope.makeUnsafe();
  const handleRequest = await rpcRuntime.run(
    NodeHttpServer.makeHandler(makeRequestApp({ authToken, corsOrigins, tickets, ui }), {
      scope: requestScope,
    }),
  );
  server.on("request", handleRequest);

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    wsHandler(ws);
  });
  wss.on("error", (e: Error & { code: string; port: number }) => {
    console.error(e);
  });

  // The only upgrade this server answers. Raw on purpose: oRPC owns this event,
  // so Effect's own websocket support (`NodeHttpServer.makeUpgradeHandler`)
  // must stay out of it.
  server.on("upgrade", (req, socket, head) => {
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
      // Interrupts any request fiber still in flight before the runtime goes.
      await Effect.runPromise(Scope.close(requestScope, Exit.void));
      await rpcRuntime.dispose();
    })());

  server.once("close", () => {
    void dispose();
  });

  return Object.assign(server, { dispose });
}
