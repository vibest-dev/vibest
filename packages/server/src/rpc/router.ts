import { os } from "@orpc/server";

import type { RpcContext } from "./context";
import { fsRouter } from "./fs";
import { gitRouter } from "./git";
import { harnessRouter } from "./harness";
import { projectRouter } from "./project";
import { ptyRouter } from "./pty";
import { sessionRouter } from "./session";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  harness: harnessRouter,
  session: sessionRouter,
  project: projectRouter,
  fs: fsRouter,
  git: gitRouter,
  pty: ptyRouter,
});
export type Router = typeof router;
