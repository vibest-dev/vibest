import { Clock, Effect, FileSystem, type PlatformError } from "effect";

import { daemonDirectory, daemonTombstonePath } from "./paths";

const tombstonePath = (home: string, daemonDir?: string): string =>
  daemonTombstonePath(daemonDir ?? daemonDirectory(home));

/**
 * The stop tombstone — `$VIBEST_DAEMON_DIR/daemon.stopped`, written by an
 * explicit `stopDaemon` so automatic supervision (the desktop's respawn loop)
 * does not resurrect a daemon the user deliberately stopped. An explicit start
 * clears it. Its mere existence is the signal; the timestamp is only for
 * debugging.
 */
export const hasTombstone = (
  home: string,
  daemonDir?: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.exists(tombstonePath(home, daemonDir))).pipe(
    Effect.orElseSucceed(() => false),
  );

export const writeTombstone = (
  home: string,
  daemonDir?: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const now = yield* Clock.currentTimeMillis;
    yield* fs.makeDirectory(daemonDir ?? daemonDirectory(home), { recursive: true });
    yield* fs.writeFileString(tombstonePath(home, daemonDir), String(now), { mode: 0o600 });
  });

export const clearTombstone = (
  home: string,
  daemonDir?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    fs.remove(tombstonePath(home, daemonDir), { force: true }),
  ).pipe(Effect.ignore);
