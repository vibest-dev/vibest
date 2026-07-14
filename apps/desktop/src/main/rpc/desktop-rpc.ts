import { RPCHandler } from "@orpc/server/fetch";
import { CORSHandlerPlugin } from "@orpc/server/plugins";
import { Context } from "effect";

import { DESKTOP_RPC_PREFIX } from "../../shared/desktop-rpc";
import type { DesktopApplication } from "../application/desktop-application";
import { type DesktopRpcContext, logDesktopRpcErrors, makeDesktopRouter } from "./desktop-router";

export type DesktopRequestHandler = (request: Request) => Promise<Response | undefined>;

export function makeDesktopRpcHandler(
  application: DesktopApplication,
  allowedOrigins: readonly string[],
): DesktopRequestHandler {
  const handler = new RPCHandler(makeDesktopRouter(application), {
    clientInterceptors: [logDesktopRpcErrors],
    plugins: [
      new CORSHandlerPlugin({
        origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
        allowMethods: ["POST", "OPTIONS"],
        maxAge: 600,
      }),
    ],
  });
  const context: DesktopRpcContext = { "effect/context": Context.empty() };

  return async (request) => {
    const result = await handler.handle(request, {
      prefix: DESKTOP_RPC_PREFIX,
      context,
    });
    return result.matched ? result.response : undefined;
  };
}
