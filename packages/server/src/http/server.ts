import type { RequestListener, Server } from "node:http";
import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Cause, Data, Effect, Exit, Scope } from "effect";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { createRpcRuntime, createWsRPCHandler, type RpcRuntime } from "../rpc";
import { makeRequestApp } from "./app";
import { createTicketStore, type TicketStore } from "./auth";
import { isAllowedOrigin, isLoopbackHost } from "./cors";
import { createUIHandler, type UIApp } from "./ui";

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
  /**
   * Extra Host-header allowlist entries on top of loopback, for a trusted
   * reverse proxy in front of the daemon (e.g. `tailscale serve`, which
   * preserves the tailnet MagicDNS Host). Unset in the common case.
   */
  allowedHosts?: readonly string[] | undefined;
};

/** Startup failed for an operational reason: building the server or binding. */
export class ServerStartupError extends Data.TaggedError("ServerStartupError")<{
  readonly phase: "create" | "listen";
  readonly cause: unknown;
}> {}

/**
 * The effectful startup stages, injectable so a test can fail any one of them
 * and assert that every earlier stage's finalizer still runs (issue #155).
 */
export type ServerStages = {
  readonly createRpcRuntime: () => Promise<RpcRuntime>;
  readonly createUI: (runtime: RpcRuntime) => Promise<UIApp>;
  readonly createRequestHandler: (
    runtime: RpcRuntime,
    app: ReturnType<typeof makeRequestApp>,
    requestScope: Scope.Scope,
  ) => Promise<RequestListener>;
};

const defaultStages: ServerStages = {
  createRpcRuntime: () => createRpcRuntime(),
  createUI: (runtime) => runtime.run(createUIHandler()),
  // The request half is Effect-native and runs on the RPC runtime, which
  // already carries FileSystem/Path/HttpPlatform. `makeHandler` gives back a
  // plain node `request` listener, which is the whole point: it leaves the
  // `upgrade` event untouched. (`HttpServer.serve` would register its own
  // upgrade handler and fight oRPC for it.)
  createRequestHandler: (runtime, app, requestScope) =>
    runtime.run(NodeHttpServer.makeHandler(app, { scope: requestScope })),
};

type WiredServer = {
  readonly server: Server;
  readonly wss: WebSocketServer;
};

function wireServer(options: {
  readonly authToken: string | undefined;
  readonly corsOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly tickets: TicketStore;
  readonly wsHandler: (ws: WebSocket) => void;
  readonly handleRequest: RequestListener;
}): WiredServer {
  const { authToken, corsOrigins, allowedHosts, tickets, wsHandler, handleRequest } = options;

  const server = http.createServer();
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
      !isLoopbackHost(req.headers.host, allowedHosts) ||
      (origin !== undefined &&
        !isAllowedOrigin(origin, { extraOrigins: corsOrigins, allowedHosts }))
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

  return { server, wss };
}

const closeWiredServer = ({ server, wss }: WiredServer) =>
  Effect.promise(async () => {
    const serverClosed = server.listening
      ? new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
      : Promise.resolve();

    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await serverClosed;
  });

/**
 * Staged, scoped construction: every resource registers its finalizer in the
 * scope immediately after it is acquired, so a failure in any later stage
 * releases everything acquired before it, and normal disposal releases the
 * stages in reverse acquisition order. A finalizer that fails does not stop
 * the ones behind it — the scope runs them all and aggregates the causes.
 */
const buildServer = (
  options: CreateServerOptions,
  stages: ServerStages,
): Effect.Effect<Server, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { authToken, corsOrigins = [], allowedHosts = [] } = options;

    const rpcRuntime = yield* Effect.acquireRelease(
      Effect.promise(() => stages.createRpcRuntime()),
      (runtime) => Effect.promise(() => runtime.dispose()),
    );
    const wsHandler = createWsRPCHandler(rpcRuntime.context);
    const tickets = createTicketStore();

    const ui = yield* Effect.promise(() => stages.createUI(rpcRuntime));

    // Closing this scope interrupts any request fiber still in flight; its
    // release sits between the listeners stopping and the runtime going.
    const requestScope = yield* Effect.acquireRelease(
      Effect.sync(() => Scope.makeUnsafe()),
      (scope) => Scope.close(scope, Exit.void),
    );
    const handleRequest = yield* Effect.promise(() =>
      stages.createRequestHandler(
        rpcRuntime,
        makeRequestApp({ authToken, corsOrigins, allowedHosts, tickets, ui }),
        requestScope,
      ),
    );

    // Last stage, so its release runs first: stop accepting connections and
    // drain both socket populations before anything behind them is torn down.
    const { server } = yield* Effect.acquireRelease(
      Effect.sync(() =>
        wireServer({ authToken, corsOrigins, allowedHosts, tickets, wsHandler, handleRequest }),
      ),
      closeWiredServer,
    );
    return server;
  });

export async function createServer(
  options: CreateServerOptions = {},
  stages: ServerStages = defaultStages,
): Promise<ManagedServer> {
  const scope = Scope.makeUnsafe();
  let disposing: Promise<void> | undefined;
  const dispose = () => (disposing ??= Effect.runPromise(Scope.close(scope, Exit.void)));

  const built = await Effect.runPromiseExit(
    buildServer(options, stages).pipe(Scope.provide(scope)),
  );
  if (Exit.isFailure(built)) {
    // A later stage failed: release every stage that already succeeded, then
    // surface the original failure. A cleanup failure must not mask it.
    const cleanup = await Effect.runPromiseExit(Scope.close(scope, built));
    if (Exit.isFailure(cleanup)) {
      console.error("[server] cleanup after failed startup", Cause.squash(cleanup.cause));
    }
    throw Cause.squash(built.cause);
  }

  const server = built.value;
  server.once("close", () => {
    void dispose();
  });

  return Object.assign(server, { dispose });
}
