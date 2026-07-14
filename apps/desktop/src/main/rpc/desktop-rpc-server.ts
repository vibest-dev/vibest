import type { SupportedMessagePort } from "@orpc/client/message-port";
import { RPCHandler } from "@orpc/server/message-port";
import { Context } from "effect";

import type { DesktopApplication } from "../application/desktop-application";
import { type DesktopRpcContext, logDesktopRpcErrors, makeDesktopRouter } from "./desktop-router";

export interface DesktopRpcServer {
  readonly attach: (port: SupportedMessagePort) => () => Promise<void>;
}

export function makeDesktopRpcServer(application: DesktopApplication): DesktopRpcServer {
  const handler = new RPCHandler(makeDesktopRouter(application), {
    clientInterceptors: [logDesktopRpcErrors],
  });
  const context: DesktopRpcContext = { "effect/context": Context.empty() };

  return {
    attach: (port) => {
      handler.upgrade(port, { context });
      return () => handler.close(port);
    },
  };
}
