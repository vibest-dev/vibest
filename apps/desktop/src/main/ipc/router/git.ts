import { implement } from "@orpc/server";

import type { AppContext } from "../../app";

import { gitContract } from "../../../shared/contract";

const os = implement(gitContract).$context<AppContext>();

export const getStatus = os.status.handler(async ({ input, context: { app } }) => {
  return app.git.getStatus(input.path);
});

export const fetchGit = os.fetch.handler(async ({ input, context: { app } }) => {
  await app.git.fetch(input.path);
});

export const pullGit = os.pull.handler(async ({ input, context: { app } }) => {
  await app.git.pull(input.path);
});

export const getBranches = os.branches.handler(async ({ input, context: { app } }) => {
  return app.git.getBranches(input.path);
});

export const getDiff = os.diff.handler(async ({ input, context: { app } }) => {
  return app.git.getDiff(input.path, input.staged);
});

// Streaming subscription for git changes using Publisher
export const watchChanges = os.watchChanges.handler(async function* ({
  input,
  signal,
  context: { app },
}) {
  const { path } = input;

  // Start watching this path when client subscribes
  app.gitWatcher.watch(path);

  // Subscribe to git changes for this path
  const abortSignal = signal ?? AbortSignal.timeout(Infinity);
  const iterator = app.publisher.subscribe(`git:changes:${path}`, {
    signal: abortSignal,
  });

  try {
    for await (const event of iterator) {
      yield event;
    }
  } finally {
    // Stop watching when client disconnects
    app.gitWatcher.unwatch(path);
  }
});

export const gitRouter = os.router({
  status: getStatus,
  fetch: fetchGit,
  pull: pullGit,
  branches: getBranches,
  diff: getDiff,
  watchChanges,
});
