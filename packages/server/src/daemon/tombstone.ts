import { Clock, Effect, FileSystem, type PlatformError } from "effect";

import { daemonDirectory, daemonTombstonePath, legacyTombstonePath } from "./paths";

/**
 * The stop tombstone — `$VIBEST_HOME/daemon/daemon.stopped`, written by an explicit
 * `stopDaemon` so automatic supervision (the desktop's respawn loop) does not
 * resurrect a daemon the user deliberately stopped. An explicit start clears
 * it. Its mere existence is the signal; the timestamp is only for debugging.
 */
export const hasTombstone = (
  home: string,
  daemonDir?: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    Effect.gen(function* () {
      if (yield* fs.exists(daemonTombstonePath(daemonDir ?? daemonDirectory(home)))) return true;
      return daemonDir === undefined ? yield* fs.exists(legacyTombstonePath(home)) : false;
    }),
  ).pipe(Effect.orElseSucceed(() => false));

export const writeTombstone = (
  home: string,
  daemonDir?: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const now = yield* Clock.currentTimeMillis;
    const configuredDir = daemonDir ?? daemonDirectory(home);
    yield* fs.makeDirectory(configuredDir, { recursive: true });
    const files = [
      daemonTombstonePath(configuredDir),
      ...(daemonDir === undefined ? [legacyTombstonePath(home)] : []),
    ];
    yield* Effect.all(
      files.map((file) => fs.writeFileString(file, String(now), { mode: 0o600 })),
      { discard: true },
    );
  });

export const clearTombstone = (
  home: string,
  daemonDir?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => {
    const files = [
      daemonTombstonePath(daemonDir ?? daemonDirectory(home)),
      ...(daemonDir === undefined ? [legacyTombstonePath(home)] : []),
    ];
    return Effect.all(
      files.map((file) => fs.remove(file, { force: true })),
      { discard: true },
    );
  }).pipe(Effect.ignore);
