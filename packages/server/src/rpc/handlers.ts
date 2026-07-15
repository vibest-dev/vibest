import type { Buffer } from "node:buffer";
import type * as http from "node:http";
import type { Socket } from "node:net";

import { RPCHandler as FetchRPCHandler } from "@orpc/server/fetch";
import { RPCHandler as NodeRPCHandler } from "@orpc/server/node";
import { RPCHandler as WsRPCHandler } from "@orpc/server/websocket";
import { ManagedRuntime } from "effect";
import { type WebSocket, WebSocketServer } from "ws";

import type { RpcContext } from "./context";
import { router } from "./router";
import { AgentRuntimeLayer } from "./runtime";

const RPC_PREFIX = "/api/rpc";

// Without this, a procedure that throws becomes a bare 500 with no trace of the
// cause anywhere — the client sees "Internal Server Error" and the server says
// nothing at all. Generic in the result so it types against every handler's
// own client-interceptor signature.
async function logErrors<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  try {
    return await next();
  } catch (error) {
    console.error("[rpc]", error);
    throw error;
  }
}

export type RpcRuntime = {
  readonly context: RpcContext;
  readonly dispose: () => Promise<void>;
};

export async function createRpcRuntime(): Promise<RpcRuntime> {
  const runtime = ManagedRuntime.make(AgentRuntimeLayer);
  const context: RpcContext = {
    "effect/context": await runtime.runPromise(runtime.contextEffect),
  };
  let disposing: Promise<void> | undefined;
  return {
    context,
    dispose: () => (disposing ??= runtime.dispose()),
  };
}

export function createFetchRPCHandler(rpcContext: RpcContext) {
  const rpcHandler = new FetchRPCHandler(router, {
    clientInterceptors: [logErrors],
    toFetchResponse: {
      eventStream: {
        keepAlive: { enabled: true, comment: "ping" },
      },
    },
  });

  return async function handler(
    request: Request,
    options?: {
      prefix?: `/${string}`;
    },
  ) {
    return rpcHandler.handle(request, {
      prefix: "/api/rpc",
      context: rpcContext,
      ...options,
    });
  };
}

export function createNodeRPCHandler(rpcContext: RpcContext) {
  const rpcHandler = new NodeRPCHandler(router, {
    clientInterceptors: [logErrors],
    sendStandardResponse: {
      eventStream: {
        keepAlive: { enabled: true, comment: "ping" },
      },
    },
  });

  return async function handler(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    options?: {
      prefix?: `/${string}`;
    },
  ) {
    return rpcHandler.handle(request, response, {
      prefix: RPC_PREFIX,
      context: rpcContext,
      ...options,
    });
  };
}

export function createWsRPCHandler(rpcContext: RpcContext) {
  const wsHandler = new WsRPCHandler<RpcContext>(router, { clientInterceptors: [logErrors] });

  return function upgrade(ws: WebSocket) {
    wsHandler.upgrade(ws, {
      context: rpcContext,
    });
  };
}

type DevWsLogger = Pick<Console, "error">;

type DevWsRPCHandlerOptions = {
  path: string;
  logger?: DevWsLogger;
};

export type DevWsRPCHandler = {
  handleUpgrade(request: http.IncomingMessage, socket: Socket, head: Buffer): boolean;
  teardown(): void;
};

export function createDevWsRPCHandler(
  { path, logger }: DevWsRPCHandlerOptions,
  rpcContext: RpcContext,
): DevWsRPCHandler {
  const webSocketServer = new WebSocketServer({ noServer: true });
  const upgradeHandler = createWsRPCHandler(rpcContext);

  const connectionListener = (socket: WebSocket) => {
    upgradeHandler(socket);
  };

  webSocketServer.on("connection", connectionListener);

  function handleUpgrade(request: http.IncomingMessage, socket: Socket, head: Buffer): boolean {
    let requestUrl: URL;

    try {
      requestUrl = new URL(request.url ?? "", "http://localhost");
    } catch (error) {
      logger?.error(`Failed to parse ORPC WebSocket request URL: ${(error as Error).message}`);
      socket.destroy();
      return false;
    }

    if (requestUrl.pathname !== path) {
      return false;
    }

    try {
      webSocketServer.handleUpgrade(request, socket, head, (ws) => {
        connectionListener(ws);
      });
    } catch (error) {
      logger?.error(`Failed to upgrade ORPC WebSocket connection: ${(error as Error).message}`);
      socket.destroy();
      return false;
    }

    return true;
  }

  function teardown() {
    webSocketServer.off("connection", connectionListener);

    for (const client of webSocketServer.clients) {
      client.terminate();
    }

    webSocketServer.close();
  }

  return {
    handleUpgrade,
    teardown,
  };
}
