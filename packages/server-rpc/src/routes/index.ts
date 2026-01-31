import { os } from "@orpc/server";

import { type ClaudeCodeContext, claudeCodeRouter } from "./claude-code";

const orpc = os.$context<ClaudeCodeContext>();

export const router = orpc.router({
  claudeCode: claudeCodeRouter,
});
export type Router = typeof router;
