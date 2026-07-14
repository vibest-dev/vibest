import { os } from "@orpc/server";

import { claudeCodeRouter } from "./claude-code";
import { codexRouter } from "./codex";
import type { RpcContext } from "./context";

const orpc = os.$context<RpcContext>();

export const router = orpc.router({
  claudeCode: claudeCodeRouter,
  codex: codexRouter,
});
export type Router = typeof router;
