import { os } from "@orpc/server";

import type { RpcContext } from "./context";
import { sessionRouter } from "./session";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  session: sessionRouter,
});
export type Router = typeof router;
