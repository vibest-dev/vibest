import { Effect, FileSystem, type PlatformError } from "effect";

import { legacyLockPath, lockPath } from "./paths";

/**
 * The launch lock — an exclusive-create `$VIBEST_HOME/daemon/daemon.lock` holding the
 * acquiring launcher's pid. It serializes spawns so two launchers racing an
 * empty home (or a respawn window) cannot both spawn a daemon; the loser waits
 * for the winner's record and attaches. A lock whose holder pid has died is
 * reclaimable. This is the file-state seam; the retry/wait orchestration lives
 * in the launcher.
 */

/**
 * Create the lock atomically. True when acquired; false when someone holds it.
 *
 * The exclusivity is the OS's, not ours: `wx` is `O_CREAT | O_EXCL`, so exactly
 * one racing launcher can win however the writes are scheduled. Anything other
 * than "already there" (unwritable home, full disk) is a real launch failure
 * and stays in the error channel.
 */
export const tryAcquireLock = (
  home: string,
): Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    Effect.gen(function* () {
      // The root-level lock remains canonical during the compatibility window:
      // old launchers see it, so mixed old/new clients cannot spawn twice.
      const acquired = yield* fs
        .writeFileString(legacyLockPath(home), String(process.pid), {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            () => Effect.succeed(false),
          ),
        );
      if (!acquired) return false;

      // Nested copy is diagnostic state only; the root lock owns exclusivity.
      // If it cannot be written, give the canonical lock back before failing.
      yield* fs
        .writeFileString(lockPath(home), String(process.pid), { mode: 0o600 })
        .pipe(Effect.tapError(() => fs.remove(legacyLockPath(home), { force: true })));
      return true;
    }),
  );

/** The pid recorded in the lock, or `undefined` if missing/garbage. */
export const readLockPid = (
  home: string,
): Effect.Effect<number | undefined, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    Effect.gen(function* () {
      for (const file of [legacyLockPath(home), lockPath(home)]) {
        const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
        const pid = Number.parseInt(raw, 10);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      return undefined;
    }),
  );

/** Whether the lock still exists (a concurrent launcher is still spawning). */
export const lockExists = (home: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    Effect.gen(function* () {
      if (yield* fs.exists(legacyLockPath(home))) return true;
      return yield* fs.exists(lockPath(home));
    }),
  ).pipe(Effect.orElseSucceed(() => false));

/** Release current and legacy locks; missing files are not errors. */
export const releaseLock = (home: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    Effect.all(
      [lockPath(home), legacyLockPath(home)].map((file) => fs.remove(file, { force: true })),
      { discard: true },
    ),
  ).pipe(Effect.ignore);
