import { os } from "@orpc/server";

import type { RpcContext } from "./context";
import { harnessRouter } from "./harness";
import { sessionRouter } from "./session";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  harness: harnessRouter,
  session: sessionRouter,
});
export type Router = typeof router;
