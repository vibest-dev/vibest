import type { RpcContext } from "./context";

import { os } from "@orpc/server";

import { claudeCodeRouter } from "./claude-code";
import { codexRouter } from "./codex";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  claudeCode: claudeCodeRouter,
  codex: codexRouter,
});
export type Router = typeof router;
