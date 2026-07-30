import path from "node:path";

import { Effect, FileSystem, type PlatformError } from "effect";

/**
 * The launch lock — an exclusive-create `$VIBEST_HOME/daemon.lock` holding the
 * acquiring launcher's pid. It serializes spawns so two launchers racing an
 * empty home (or a respawn window) cannot both spawn a daemon; the loser waits
 * for the winner's record and attaches. A lock whose holder pid has died is
 * reclaimable. This is the file-state seam; the retry/wait orchestration lives
 * in the launcher.
 */
const lockPath = (home: string): string => path.join(home, "daemon.lock");

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
    fs.writeFileString(lockPath(home), String(process.pid), { flag: "wx", mode: 0o600 }),
  ).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.reason._tag === "AlreadyExists",
      () => Effect.succeed(false),
    ),
  );

/** The pid recorded in the lock, or `undefined` if missing/garbage. */
export const readLockPid = (
  home: string,
): Effect.Effect<number | undefined, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(lockPath(home))).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((raw) => {
      const pid = Number.parseInt(raw, 10);
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    }),
  );

/** Whether the lock still exists (a concurrent launcher is still spawning). */
export const lockExists = (home: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.exists(lockPath(home))).pipe(
    Effect.orElseSucceed(() => false),
  );

/** Release the lock; a missing lock (or a lost reclaim race) is not an error. */
export const releaseLock = (home: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.remove(lockPath(home), { force: true })).pipe(Effect.ignore);
