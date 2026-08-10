import path from "node:path";

import { Cause, Clock, Effect, FileSystem, Logger, Ref, type Scope } from "effect";

import { jsonl } from "./format";
import { dayKey, LOG_DIRECTORY_MODE, LOG_FILE_MODE, LOG_FILE_PATTERN, logFileFor } from "./paths";

/**
 * How long writes are buffered. `Logger.batched` also flushes whatever is
 * pending when the scope closes, so a clean shutdown loses nothing.
 */
const FLUSH_WINDOW_MS = 1000;

const MILLIS_PER_DAY = 86_400_000;

/**
 * Drop log files whose day is older than the retention window. Best-effort:
 * an unreadable directory or an undeletable file must not stop the server
 * from starting, and the next startup tries again.
 */
const prune = (
  fs: FileSystem.FileSystem,
  directory: string,
  retentionDays: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cutoff = dayKey(new Date(now - retentionDays * MILLIS_PER_DAY));
    const entries = yield* fs.readDirectory(directory);
    for (const entry of entries) {
      const day = LOG_FILE_PATTERN.exec(entry)?.[1];
      if (day === undefined || day >= cutoff) continue;
      yield* fs.remove(path.join(directory, entry), { force: true }).pipe(Effect.ignore);
    }
  }).pipe(Effect.ignore);

/**
 * Report a write failure exactly once, on the console.
 *
 * It cannot go through `Effect.log` — this *is* the log sink, and routing its
 * own failure back into itself would recurse. Once is enough: a full disk
 * fails every flush, and a line per second would bury the very output someone
 * is trying to read.
 */
const reportOnce = (
  reported: Ref.Ref<boolean>,
  file: string,
  cause: Cause.Cause<unknown>,
): Effect.Effect<void> =>
  Effect.flatMap(Ref.getAndSet(reported, true), (already) =>
    already
      ? Effect.void
      : Effect.sync(() => {
          console.error(
            `[vibest] cannot write ${file}; logs are not being persisted (further failures silent)`,
            Cause.squash(cause),
          );
        }),
  );

/**
 * A JSONL logger that rolls over at local midnight and prunes old days.
 *
 * Deliberately holds no file descriptor: each flush appends with `flag: "a"`,
 * so the day boundary is expressed entirely in the path and there is no fd to
 * reopen, hand off, or leak. Batching keeps that to roughly one `write` per
 * second.
 *
 * A batch is filed under the day it is *flushed*, so a line emitted just before
 * midnight can land in the next day's file. Every line carries its own
 * `timestamp`, so this costs nothing when reading.
 */
export const makeFileLogger = (options: {
  readonly directory: string;
  readonly retentionDays: number;
}): Effect.Effect<Logger.Logger<unknown, void>, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Both best-effort: logging must never be the reason the server won't boot.
    yield* fs
      .makeDirectory(options.directory, { recursive: true, mode: LOG_DIRECTORY_MODE })
      .pipe(Effect.ignore);
    yield* prune(fs, options.directory, options.retentionDays);

    const reported = yield* Ref.make(false);

    return yield* Logger.batched(jsonl, {
      window: FLUSH_WINDOW_MS,
      // `Logger.batched` clears its buffer before calling `flush`. If the scope
      // closes during this write, interrupting it would lose that whole batch.
      flush: (lines) =>
        Effect.gen(function* () {
          if (lines.length === 0) return;
          const file = logFileFor(options.directory, new Date(yield* Clock.currentTimeMillis));
          yield* fs
            .writeFileString(file, `${lines.join("\n")}\n`, { flag: "a", mode: LOG_FILE_MODE })
            .pipe(Effect.catchCause((cause) => reportOnce(reported, file, cause)));
        }).pipe(Effect.uninterruptible),
    });
  });
