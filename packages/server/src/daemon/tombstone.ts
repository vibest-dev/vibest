import { Clock, Effect, FileSystem, Path, type PlatformError } from "effect";

/**
 * The stop tombstone — `$VIBEST_HOME/daemon.stopped`, written by an explicit
 * `stopDaemon` so automatic supervision (the desktop's respawn loop) does not
 * resurrect a daemon the user deliberately stopped. An explicit start clears
 * it. Its mere existence is the signal; the timestamp is only for debugging.
 */
const tombstoneFile = (path: Path.Path, home: string): string => path.join(home, "daemon.stopped");

export const hasTombstone = (
  home: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.exists(tombstoneFile(path, home)).pipe(Effect.orElseSucceed(() => false));
  });

export const writeTombstone = (
  home: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    yield* fs.makeDirectory(home, { recursive: true });
    yield* fs.writeFileString(tombstoneFile(path, home), String(now), { mode: 0o600 });
  });

export const clearTombstone = (
  home: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(tombstoneFile(path, home), { force: true }).pipe(Effect.ignore);
  });
