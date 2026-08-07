import fs from "node:fs";

import { Effect, type Scope } from "effect";

import { logFileFor } from "./paths";

/**
 * Deliberately `node:fs` and deliberately synchronous.
 *
 * This runs while the process is dying. The batched file logger holds up to a
 * second of entries and flushes on a fiber; neither survives here, and an
 * `Effect` scheduled now would never get a turn. Writing the bytes inline is
 * the only way the last words reach the disk — the same reason
 * `daemon/launcher.ts`'s `spawnDetached` is exempt from the platform-service
 * rule (`.agents/rules/stack.md`).
 */
const writeCrashLine = (directory: string, error: unknown): void => {
  try {
    const now = new Date();
    const line = JSON.stringify({
      message: "process crashed",
      level: "FATAL",
      timestamp: now.toISOString(),
      annotations: { event: "process.crashed" },
      spans: {},
      pid: process.pid,
      fiberId: "#0",
      cause: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    // Same owner-only mode as the batched sink: this appends to the very same
    // file, and whichever of the two creates it decides the permissions.
    fs.appendFileSync(logFileFor(directory, now), `${line}\n`, { mode: 0o600 });
  } catch {
    // Nothing sensible is left to do — the process is going down regardless,
    // and Node still prints the stack to stderr on its way out.
  }
};

/**
 * Record an otherwise-fatal error into the same JSONL the rest of the server
 * writes, so a crash is something you find while reading the log rather than
 * something you notice by the log stopping.
 *
 * `uncaughtExceptionMonitor` rather than `uncaughtException`: the monitor
 * observes and leaves Node's default behaviour intact (print the stack, exit
 * non-zero). A plain `uncaughtException` listener *suppresses* the default,
 * silently converting every crash into a survivable event — a much larger
 * change than adding a log line, and not one this should make.
 *
 * Unhandled rejections arrive here too: Node's default mode (`throw`) turns
 * them into uncaught exceptions, which the monitor sees.
 */
export const installCrashHandler = (directory: string): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const handler = (error: unknown) => {
      writeCrashLine(directory, error);
    };
    process.on("uncaughtExceptionMonitor", handler);
    // Removed with the scope so a test (or a second runtime in one process)
    // cannot accumulate listeners and trip Node's max-listeners warning.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.off("uncaughtExceptionMonitor", handler);
      }),
    );
  });
