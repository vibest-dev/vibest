import type { RpcContext } from "./claude-code";

import { os } from "@orpc/server";

import { claudeCodeRouter } from "./claude-code";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  claudeCode: claudeCodeRouter,
});
export type Router = typeof router;
