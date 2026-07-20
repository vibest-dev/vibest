import { os } from "@orpc/server";

import type { RpcContext } from "./context";
import { fsRouter } from "./fs";
import { harnessRouter } from "./harness";
import { projectRouter } from "./project";
import { sessionRouter } from "./session";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  harness: harnessRouter,
  session: sessionRouter,
  project: projectRouter,
  fs: fsRouter,
});
export type Router = typeof router;
