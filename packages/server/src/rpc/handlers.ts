import type { Buffer } from "node:buffer";
import type * as http from "node:http";
import type { Socket } from "node:net";

import { RPCHandler as FetchRPCHandler } from "@orpc/server/fetch";
import { RPCHandler as NodeRPCHandler } from "@orpc/server/node";
import { RPCHandler as WsRPCHandler } from "@orpc/server/websocket";
import { ManagedRuntime } from "effect";
import { type WebSocket, WebSocketServer } from "ws";

import type { RpcContext } from "./claude-code";

import { ClaudeCodeLayer } from "./claude-code";
import { router } from "./router";

const RPC_PREFIX = "/api/rpc";

// One runtime per process, shared by every transport. The layer is fully
// synchronous today so its context can be extracted eagerly; when scoped
// services (finalizers, child processes) join the layer, dispose the runtime
// on server shutdown (design §6).
const runtime = ManagedRuntime.make(ClaudeCodeLayer);
const rpcContext: RpcContext = {
  "effect/context": runtime.runSync(runtime.contextEffect),
};

export function createFetchRPCHandler() {
  const rpcHandler = new FetchRPCHandler(router, {
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

export function createNodeRPCHandler() {
  const rpcHandler = new NodeRPCHandler(router, {
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

export function createWsRPCHandler() {
  const wsHandler = new WsRPCHandler<RpcContext>(router);

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

export function createDevWsRPCHandler({ path, logger }: DevWsRPCHandlerOptions): DevWsRPCHandler {
  const webSocketServer = new WebSocketServer({ noServer: true });
  const upgradeHandler = createWsRPCHandler();

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
