import type { HTTPPath } from "@orpc/server";
import type { Buffer } from "node:buffer";
import type * as http from "node:http";
import type { Socket } from "node:net";

import { RPCHandler as FetchRPCHandler } from "@orpc/server/fetch";
import { RPCHandler as NodeRPCHandler } from "@orpc/server/node";
import { RPCHandler as WsRPCHandler } from "@orpc/server/ws";
import { ClaudeCodeAgent } from "@vibest/agents/claude-code";
import { type WebSocket, WebSocketServer } from "ws";

import type { ClaudeCodeContext } from "./routes/claude-code";

import { router } from "./routes";

const RPC_PREFIX = "/api/rpc";
const claudeCodeAgent = new ClaudeCodeAgent();

export function createFetchRPCHandler() {
  const rpcHandler = new FetchRPCHandler(router, {
    eventIteratorKeepAliveComment: "ping",
  });

  return async function handler(
    request: Request,
    options?: {
      prefix?: HTTPPath;
    },
  ) {
    return rpcHandler.handle(request, {
      prefix: "/api/rpc",
      context: { claudeCodeAgent },
      ...options,
    });
  };
}

export function createNodeRPCHandler() {
  const rpcHandler = new NodeRPCHandler(router, {
    eventIteratorKeepAliveComment: "ping",
  });

  return async function handler(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    options?: {
      prefix?: HTTPPath;
    },
  ) {
    return rpcHandler.handle(request, response, {
      prefix: RPC_PREFIX,
      context: {
        claudeCodeAgent,
      },
      ...options,
    });
  };
}

export function createWsRPCHandler() {
  const wsHandler = new WsRPCHandler<ClaudeCodeContext>(router);

  return function upgrade(ws: WebSocket) {
    wsHandler.upgrade(ws, {
      context: {
        claudeCodeAgent,
      },
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
