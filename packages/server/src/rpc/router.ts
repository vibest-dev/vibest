import { os } from "@orpc/server";

import type { RpcContext } from "./claude-code";
import { claudeCodeRouter } from "./claude-code";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  claudeCode: claudeCodeRouter,
});
export type Router = typeof router;
