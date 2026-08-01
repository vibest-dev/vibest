import { Clock, Effect, FileSystem, type PlatformError } from "effect";

import { daemonTombstonePath } from "./paths";

/**
 * Whether the stop tombstone is present — `$VIBEST_DAEMON_DIR/daemon.stopped`,
 * written by an explicit `stopDaemon` so automatic supervision (the desktop's
 * respawn loop) does not resurrect a daemon the user deliberately stopped. An
 * explicit start clears it. Its mere existence is the signal; the timestamp is
 * only for debugging.
 */
export const hasTombstone = (
  daemonDir: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.exists(daemonTombstonePath(daemonDir))).pipe(
    Effect.orElseSucceed(() => false),
  );

export const writeTombstone = (
  daemonDir: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const now = yield* Clock.currentTimeMillis;
    yield* fs.makeDirectory(daemonDir, { recursive: true });
    yield* fs.writeFileString(daemonTombstonePath(daemonDir), String(now), { mode: 0o600 });
  });

export const clearTombstone = (
  daemonDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    fs.remove(daemonTombstonePath(daemonDir), { force: true }),
  ).pipe(Effect.ignore);
