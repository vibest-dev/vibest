import os from "node:os";

import { Effect, Layer } from "effect";
/**
 * node-pty has no Effect equivalent: a real TTY (winsize, job control, curses)
 * is outside ChildProcessSpawner's piped-stdio model. This file is the seam.
 */
import * as nodePty from "node-pty";

import { PtySpawnFailed } from "../errors";
import { PtySpawner, type SpawnedPty } from "./types";

export const NodePtySpawnerLayer: Layer.Layer<PtySpawner> = Layer.sync(PtySpawner, () => ({
  spawn: (options) =>
    Effect.try({
      try: () => {
        const proc = nodePty.spawn(options.shell, [], {
          name: "xterm-256color",
          cols: options.cols,
          rows: options.rows,
          cwd: options.cwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            HOME: process.env.HOME ?? os.homedir(),
          },
        });
        const spawned: SpawnedPty = {
          write: (data) => proc.write(data),
          resize: (cols, rows) => proc.resize(cols, rows),
          kill: () => {
            try {
              proc.kill();
            } catch {
              // Already gone.
            }
          },
          subscribe: (onData, onExit) => {
            const dataDisposable = proc.onData(onData);
            const exitDisposable = proc.onExit(({ exitCode }) => onExit(exitCode));
            return () => {
              dataDisposable.dispose();
              exitDisposable.dispose();
            };
          },
        };
        return spawned;
      },
      catch: (cause) => new PtySpawnFailed({ projectId: options.projectId, cause }),
    }),
}));
