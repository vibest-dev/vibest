import { Clock, Effect, FileSystem, type PlatformError } from "effect";

import { daemonDirectory, legacyTombstonePath, tombstonePath } from "./paths";

/**
 * The stop tombstone — `$VIBEST_HOME/daemon/daemon.stopped`, written by an explicit
 * `stopDaemon` so automatic supervision (the desktop's respawn loop) does not
 * resurrect a daemon the user deliberately stopped. An explicit start clears
 * it. Its mere existence is the signal; the timestamp is only for debugging.
 */
export const hasTombstone = (home: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    Effect.gen(function* () {
      if (yield* fs.exists(tombstonePath(home))) return true;
      return yield* fs.exists(legacyTombstonePath(home));
    }),
  ).pipe(Effect.orElseSucceed(() => false));

export const writeTombstone = (
  home: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const now = yield* Clock.currentTimeMillis;
    yield* fs.makeDirectory(daemonDirectory(home), { recursive: true });
    yield* Effect.all(
      [tombstonePath(home), legacyTombstonePath(home)].map((file) =>
        fs.writeFileString(file, String(now), { mode: 0o600 }),
      ),
      { discard: true },
    );
  });

export const clearTombstone = (home: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    Effect.all(
      [tombstonePath(home), legacyTombstonePath(home)].map((file) =>
        fs.remove(file, { force: true }),
      ),
      { discard: true },
    ),
  ).pipe(Effect.ignore);
