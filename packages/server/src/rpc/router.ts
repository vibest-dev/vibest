import { os } from "@orpc/server";

import type { RpcContext } from "./context";
import { fsRouter } from "./fs";
import { projectRouter } from "./project";
import { sessionRouter } from "./session";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  project: projectRouter,
  session: sessionRouter,
  fs: fsRouter,
});
export type Router = typeof router;
