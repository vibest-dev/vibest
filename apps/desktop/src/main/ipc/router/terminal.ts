import { implement } from "@orpc/server";
import * as path from "node:path";

import type { AppContext } from "../../app";

import { terminalContract } from "../../../shared/contract/terminal";

const os = implement(terminalContract).$context<AppContext>();

export const create = os.create.handler(async ({ input, context: { app } }) => {
  const { worktreeId, cwd } = input;

  // Validate that cwd is within the worktree directory
  const worktree = app.store.getWorktree(worktreeId);
  if (!worktree) {
    throw new Error("Worktree not found");
  }

  const resolvedCwd = path.resolve(cwd);
  const worktreePath = path.resolve(worktree.path);

  // Ensure cwd is within worktree directory (prevent path traversal)
  if (!resolvedCwd.startsWith(worktreePath + path.sep) && resolvedCwd !== worktreePath) {
    throw new Error("Terminal working directory must be within worktree");
  }

  const instance = app.terminal.create(worktreeId, resolvedCwd);
  return {
    id: instance.id,
    worktreeId: instance.worktreeId,
  };
});

export const list = os.list.handler(async ({ input, context: { app } }) => {
  const { worktreeId } = input;
  const terminals = app.terminal.getTerminalsByWorktree(worktreeId);
  return terminals.map((t) => ({
    id: t.id,
    worktreeId: t.worktreeId,
  }));
});

export const write = os.write.handler(async ({ input, context: { app } }) => {
  const { terminalId, data } = input;
  app.terminal.write(terminalId, data);
});

export const resize = os.resize.handler(async ({ input, context: { app } }) => {
  const { terminalId, cols, rows } = input;
  app.terminal.resize(terminalId, cols, rows);
});

export const close = os.close.handler(async ({ input, context: { app } }) => {
  const { terminalId } = input;
  app.terminal.close(terminalId);
});

export const snapshot = os.snapshot.handler(async ({ input, context: { app } }) => {
  const { terminalId } = input;
  return app.terminal.getSnapshot(terminalId);
});

// Streaming subscription for terminal output using Publisher
export const subscribe = os.subscribe.handler(async function* ({
  input,
  signal,
  context: { app },
}) {
  const { terminalId } = input;

  // Validate terminal exists before subscribing
  const terminal = app.terminal.get(terminalId);
  if (!terminal) {
    throw new Error("Terminal not found");
  }

  const iterator = app.terminal.subscribe(terminalId, {
    signal: signal ?? AbortSignal.timeout(Infinity),
  });

  for await (const event of iterator) {
    yield event;

    // Stop iteration on exit event
    if (event.type === "exit") {
      return;
    }
  }
});

export const terminalRouter = os.router({
  create,
  list,
  write,
  resize,
  close,
  snapshot,
  subscribe,
});
