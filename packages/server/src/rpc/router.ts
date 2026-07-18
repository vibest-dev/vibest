import { os } from "@orpc/server";

import type { RpcContext } from "./context";
import { projectRouter } from "./project";
import { sessionRouter } from "./session";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  project: projectRouter,
  session: sessionRouter,
});
export type Router = typeof router;
