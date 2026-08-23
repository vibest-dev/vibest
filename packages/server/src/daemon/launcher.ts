import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Clock, Crypto, Effect, Encoding, FileSystem, type PlatformError } from "effect";

import {
  daemonStdioLogPath,
  LOG_FILE_MODE,
  LOGS_DIRECTORY_MODE,
  logsDirectory,
} from "../config/paths";
import { DaemonLaunchError, DaemonStopError, DaemonStoppedError } from "./errors";
import { daemonAlive, healthy, pidAlive } from "./liveness";
import { lockExists, readLockPid, releaseLock, tryAcquireLock } from "./lock";
import { daemonLockPath } from "./paths";
import { reservePort } from "./port";
import { type DaemonRecord, readRecord, removeRecord, writeRecord } from "./record";
import { clearTombstone, hasTombstone, writeTombstone } from "./tombstone";

const DEFAULT_PORT = 4000;
const READY_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 150;
const STOP_GRACE_MS = 5_000;
const LOCK_ATTEMPTS = 10;
/** How long `stopDaemon` waits for another launcher to release its locks. */
const STOP_LOCK_TIMEOUT_MS = 30_000;

export type DaemonHandle = {
  readonly address: string;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  /** True when an already-running daemon was attached to instead of spawned. */
  readonly reused: boolean;
};

export type ResolveDaemonOptions = {
  /**
   * `$VIBEST_HOME` — persistent Project and Session data. Only passed on to the
   * spawned daemon; no lifecycle file is derived from it.
   */
  readonly home: string;
  /**
   * `$VIBEST_DAEMON_DIR` — where the four lifecycle files live and what the
   * single-instance invariant is keyed on. Required; front doors get it from
   * `resolveDaemonLocation` (`config/paths.ts`), which explains why there is no
   * default here.
   */
  readonly daemonDir: string;
  /**
   * Root-level lifecycle directory used before daemon state moved under
   * `$VIBEST_HOME/daemon`. Only default locations provide this compatibility
   * path; explicit daemon-directory overrides remain isolated.
   */
  readonly legacyDaemonDir?: string;
  /**
   * argv that launches the plain foreground server, e.g.
   * `[process.execPath, ...process.execArgv, cliEntry, "serve"]`. The daemon is
   * just this command spawned detached — the server stays daemon-unaware.
   */
  readonly serverArgv: readonly string[];
  /** Absolute path whose disappearance means the launching installation was removed. */
  readonly launchOwnerPath: string;
  /** Preferred port; falls back to an ephemeral one if taken. Default `4000`. */
  readonly port?: number;
  /**
   * Base environment for the spawned daemon (default `process.env`). The
   * desktop passes its resolved login-shell environment plus
   * `ELECTRON_RUN_AS_NODE`; the launcher's own `VIBEST_*` entries win.
   */
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Set by automatic supervision loops (the desktop's exit-triggered respawn).
   * While the `daemon.stopped` tombstone is present, an autoRespawn caller
   * fails with `DaemonStoppedError` instead of resurrecting a daemon the user
   * explicitly stopped. Explicit front-doors leave this unset.
   */
  readonly autoRespawn?: boolean;
  readonly readyTimeoutMs?: number;
};

export type DaemonLauncherError = DaemonLaunchError | DaemonStoppedError;

/**
 * The platform services the launcher's file state runs on. Provided at each
 * front door's composition root (CLI `NodeServices`, desktop runtime).
 */
export type DaemonPlatform = FileSystem.FileSystem | Crypto.Crypto;

/**
 * The shared launcher (the local twin of the SSH launch script): read
 * `daemon.pid` in the selected daemon directory; if a healthy daemon whose
 * launch owner still exists is there, attach; otherwise spawn the foreground
 * server detached, record it, and wait for it to answer health. Both
 * the CLI and the desktop go through here so there is exactly one daemon per
 * daemon directory — concurrent launchers are serialized by an exclusive-create
 * launch lock, and the loser attaches to the winner's daemon.
 *
 * Effect-based orchestration around one deliberately-raw seam: the detached
 * spawn itself (see `spawnDetached`) — everything that sleeps, times out, or
 * can fail lives in Effect so callers get interruption and typed errors.
 *
 * There is no origin negotiation here: the daemon's CORS policy is static (the
 * desktop scheme + loopback are always trusted), so any client attaches to the
 * one daemon regardless of who started it — no restart-to-widen-CORS.
 */
type LocatedRecord = {
  readonly directory: string;
  readonly record: DaemonRecord;
};

const daemonDirectories = (daemonDir: string, legacyDaemonDir?: string): ReadonlyArray<string> =>
  legacyDaemonDir === undefined || legacyDaemonDir === daemonDir
    ? [daemonDir]
    : [daemonDir, legacyDaemonDir];

const readRecords = (
  daemonDir: string,
  legacyDaemonDir?: string,
): Effect.Effect<ReadonlyArray<LocatedRecord>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const records: LocatedRecord[] = [];
    for (const directory of daemonDirectories(daemonDir, legacyDaemonDir)) {
      const record = yield* readRecord(directory);
      if (record !== undefined) records.push({ directory, record });
    }
    return records;
  });

const sameRecord = (left: DaemonRecord, right: DaemonRecord): boolean =>
  left.pid === right.pid &&
  left.address === right.address &&
  left.token === right.token &&
  left.launchOwnerPath === right.launchOwnerPath;

const hasAnyTombstone = (
  daemonDir: string,
  legacyDaemonDir?: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    for (const directory of daemonDirectories(daemonDir, legacyDaemonDir)) {
      if (yield* hasTombstone(directory)) return true;
    }
    return false;
  });

const clearTombstones = (
  daemonDir: string,
  legacyDaemonDir?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.forEach(
    daemonDirectories(daemonDir, legacyDaemonDir),
    (directory) => clearTombstone(directory),
    { discard: true },
  );

const removeRecords = (
  daemonDir: string,
  legacyDaemonDir?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.forEach(
    daemonDirectories(daemonDir, legacyDaemonDir),
    (directory) => removeRecord(directory),
    { discard: true },
  );

const writeRecords = (
  daemonDir: string,
  legacyDaemonDir: string | undefined,
  record: DaemonRecord,
): Effect.Effect<void, DaemonLaunchError, FileSystem.FileSystem> =>
  Effect.forEach(
    daemonDirectories(daemonDir, legacyDaemonDir),
    (directory) => writeRecord(directory, record),
    { discard: true },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DaemonLaunchError({
          message: `Unable to record the vibest daemon: ${cause.message}`,
          cause,
        }),
    ),
  );

const killRecords = (
  records: ReadonlyArray<LocatedRecord>,
  exceptPid?: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pids = new Set(records.map(({ record }) => record.pid));
    for (const pid of pids) {
      if (pid !== exceptPid) yield* killPid(pid);
    }
  });

export const resolveOrSpawnDaemon = (
  options: ResolveDaemonOptions,
): Effect.Effect<DaemonHandle, DaemonLauncherError, DaemonPlatform> =>
  Effect.gen(function* () {
    const records = yield* readRecords(options.daemonDir, options.legacyDaemonDir);
    const reused = yield* reuseExisting(options, records);
    if (reused !== undefined) return reused;
    return yield* spawnLocked(options);
  });

const reuseExisting = (
  options: ResolveDaemonOptions,
  records: ReadonlyArray<LocatedRecord>,
): Effect.Effect<DaemonHandle | undefined, DaemonStoppedError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (
      options.autoRespawn === true &&
      (yield* hasAnyTombstone(options.daemonDir, options.legacyDaemonDir))
    ) {
      return yield* Effect.fail(
        new DaemonStoppedError({
          message:
            "vibest daemon was stopped explicitly; not auto-respawning (run `vibest daemon start` to start it again)",
        }),
      );
    }

    const directories = daemonDirectories(options.daemonDir, options.legacyDaemonDir);
    if (records.length !== directories.length) return undefined;
    const record = records[0]?.record;
    if (
      record === undefined ||
      !records.every((candidate) => sameRecord(candidate.record, record)) ||
      !(yield* daemonAlive(record)) ||
      !(yield* launchOwnerExists(record))
    ) {
      // A recorded-but-booting daemon still holds the launch locks, so the
      // caller falls through to `spawnLocked` and waits instead of killing it.
      // Once the locks are free, replacement and migration happen while held.
      return undefined;
    }

    // Only explicit front doors clear tombstones. An auto-respawn racing a
    // stop must leave a newly written tombstone intact for its next attempt.
    if (options.autoRespawn !== true) {
      yield* clearTombstones(options.daemonDir, options.legacyDaemonDir);
    }
    return attach(record, true);
  });

const replaceOrSpawnDaemon = (
  options: ResolveDaemonOptions,
): Effect.Effect<DaemonHandle, DaemonLauncherError, DaemonPlatform> =>
  Effect.gen(function* () {
    const records = yield* readRecords(options.daemonDir, options.legacyDaemonDir);
    if (
      options.autoRespawn === true &&
      (yield* hasAnyTombstone(options.daemonDir, options.legacyDaemonDir))
    ) {
      return yield* Effect.fail(
        new DaemonStoppedError({
          message:
            "vibest daemon was stopped explicitly; not auto-respawning (run `vibest daemon start` to start it again)",
        }),
      );
    }

    let reusable: DaemonRecord | undefined;
    for (const { record } of records) {
      if ((yield* daemonAlive(record)) && (yield* launchOwnerExists(record))) {
        reusable = record;
        break;
      }
    }

    if (options.autoRespawn !== true) {
      yield* clearTombstones(options.daemonDir, options.legacyDaemonDir);
    }
    yield* killRecords(records, reusable?.pid);
    yield* removeRecords(options.daemonDir, options.legacyDaemonDir);

    if (reusable !== undefined) {
      yield* writeRecords(options.daemonDir, options.legacyDaemonDir, reusable);
      return attach(reusable, true);
    }
    return yield* spawnDaemon(options);
  });

/** Read the current daemon's status without starting one. */
export const statusDaemon = (
  daemonDir: string,
  legacyDaemonDir?: string,
): Effect.Effect<
  { readonly running: false } | { readonly running: true; readonly record: DaemonRecord },
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const records = yield* readRecords(daemonDir, legacyDaemonDir);
    for (const { record } of records) {
      if (yield* daemonAlive(record)) return { running: true, record };
    }
    return { running: false };
  });

/**
 * Stop every discoverable daemon and leave a `daemon.stopped` tombstone so
 * automatic supervision does not resurrect one. The tombstone is written to
 * current and compatibility directories before any process is killed.
 */
export const stopDaemon = (
  daemonDir: string,
  legacyDaemonDir?: string,
  /** How long to wait for another launcher's locks. Tests shorten it. */
  lockTimeoutMs: number = STOP_LOCK_TIMEOUT_MS,
): Effect.Effect<
  "stopped" | "not-running",
  PlatformError.PlatformError | DaemonStopError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const lockDirectories = lifecycleLockDirectories(daemonDir, legacyDaemonDir);
    const fileSystem = yield* FileSystem.FileSystem;
    for (const directory of lockDirectories) {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
    }

    // Signal intent before waiting: an automatic respawn holding either lock
    // observes the tombstone, while an explicit start is stopped after it
    // publishes and releases its locks.
    yield* writeTombstones(daemonDir, legacyDaemonDir);

    const stop = Effect.gen(function* () {
      // A compatible explicit launcher may have cleared the early signal while
      // holding a lock. Reassert it inside the critical section so no
      // supervision loop can resurrect the daemon after this stop completes.
      yield* writeTombstones(daemonDir, legacyDaemonDir);
      const records = yield* readRecords(daemonDir, legacyDaemonDir);
      const running = records.filter(({ record }) => pidAlive(record.pid));
      yield* killRecords(running);
      yield* removeRecords(daemonDir, legacyDaemonDir);
      if (running.length > 0) return "stopped" as const;

      // Nothing was stopped, so leave nothing behind. Suppressing a
      // supervisor's auto-heal is the consequence of stopping a *running*
      // daemon; a no-op stop that tombstoned the home would refuse every later
      // respawn until someone ran an explicit start. The early write above only
      // had to hold a respawn off while we waited for the locks.
      yield* clearTombstones(daemonDir, legacyDaemonDir);
      return "not-running" as const;
    });

    // Bounded, unlike the spawn path's attempt counter: a launcher wedged
    // mid-publish holds its lock indefinitely, and an unbounded wait here turns
    // `vibest daemon stop` into a hang with no diagnostic.
    const deadline = (yield* Clock.currentTimeMillis) + lockTimeoutMs;
    while (true) {
      const outcome = yield* withLocks(lockDirectories, stop);
      if (outcome !== undefined) return outcome;
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        const locks = lockDirectories.map((directory) => daemonLockPath(directory)).join(" and ");
        return yield* Effect.fail(
          new DaemonStopError({
            message: `Another launcher has held the vibest daemon lock for ${lockTimeoutMs}ms. The stop tombstone is already in place, so retry once it releases (or remove ${locks} if no launcher is running).`,
          }),
        );
      }
      yield* Effect.sleep(HEALTH_POLL_INTERVAL_MS);
    }
  });

const launchOwnerExists = (
  record: DaemonRecord,
): Effect.Effect<boolean, never, FileSystem.FileSystem> => {
  const ownerPath = record.launchOwnerPath;
  if (ownerPath === undefined || !path.isAbsolute(ownerPath)) return Effect.succeed(false);
  return FileSystem.FileSystem.use((fileSystem) => fileSystem.exists(ownerPath)).pipe(
    // `exists` already answers `false` for NotFound, so the only failures left
    // here are EACCES/EIO/ELOOP — "we could not tell", not "it is gone". A
    // `false` from this helper kills a healthy daemon, so an unreadable path
    // must resolve the other way: only a definitive absence is a removed
    // installation.
    Effect.orElseSucceed(() => true),
  );
};

/** SIGTERM, wait up to the grace period, escalate to SIGKILL. */
const killPid = (pid: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!pidAlive(pid)) return;
    signal(pid, "SIGTERM");
    const deadline = (yield* Clock.currentTimeMillis) + STOP_GRACE_MS;
    while ((yield* Clock.currentTimeMillis) < deadline && pidAlive(pid)) {
      yield* Effect.sleep(100);
    }
    if (pidAlive(pid)) signal(pid, "SIGKILL");
  });

/**
 * Lock current and compatibility directories in a stable order. The legacy
 * root lock comes first so upgraded launchers serialize with old worktrees;
 * the nested lock also serializes with the layout introduced in PR #176.
 */
const lifecycleLockDirectories = (
  daemonDir: string,
  legacyDaemonDir?: string,
): ReadonlyArray<string> =>
  legacyDaemonDir === undefined || legacyDaemonDir === daemonDir
    ? [daemonDir]
    : [legacyDaemonDir, daemonDir];

const launchLockDirectories = (options: ResolveDaemonOptions): ReadonlyArray<string> =>
  lifecycleLockDirectories(options.daemonDir, options.legacyDaemonDir);

/**
 * Release order is free, unlike acquisition: each lock is its own file and
 * `releaseLock` treats a missing one as success, so nothing here can deadlock
 * or half-release.
 */
const releaseLocks = (
  directories: ReadonlyArray<string>,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.forEach(directories, (directory) => releaseLock(directory), { discard: true });

/**
 * Take every lifecycle lock in `directories` (already in a stable order), run
 * `use`, and release on every exit path — success, failure, *and interruption*.
 *
 * `Effect.ensuring` rather than a `tapError` on each acquisition: `tapError`
 * only fires on the error channel, so an interrupt landing between the first
 * and second acquisition leaked a lock whose holder pid is still alive — and a
 * live holder is exactly the case `pidAlive` reclamation refuses to clear, so
 * that lock never came back.
 *
 * Returns `undefined` without running `use` when another launcher holds one of
 * the locks; a dead holder's lock is reclaimed first so the next attempt wins.
 * Both callers' `use` values are non-`undefined`, which is what makes that
 * sentinel unambiguous.
 */
const withLocks = <A, E, R>(
  directories: ReadonlyArray<string>,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A | undefined, E | PlatformError.PlatformError, R | FileSystem.FileSystem> => {
  const held: string[] = [];
  return Effect.gen(function* () {
    for (const directory of directories) {
      if (yield* tryAcquireLock(directory)) {
        held.push(directory);
        continue;
      }
      const holder = yield* readLockPid(directory);
      if (holder !== undefined && !pidAlive(holder)) yield* releaseLock(directory);
      return undefined;
    }
    return yield* use;
  }).pipe(
    // `splice` empties the list as it hands it over, so a finalizer that somehow
    // runs twice cannot delete a lock another launcher has since acquired.
    Effect.ensuring(Effect.suspend(() => releaseLocks(held.splice(0)))),
  );
};

/**
 * Write the stop tombstone to every layout, attempting all of them before
 * re-raising the first failure. A fail-fast `Effect.forEach` wrote the nested
 * directory first, so one unwritable directory aborted `stopDaemon` before it
 * killed anything *and* before the root tombstone existed — the two halves of
 * "leaves tombstones in both layouts" failed together.
 */
const writeTombstones = (
  daemonDir: string,
  legacyDaemonDir?: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    let failure: PlatformError.PlatformError | undefined;
    for (const directory of daemonDirectories(daemonDir, legacyDaemonDir)) {
      yield* writeTombstone(directory).pipe(
        Effect.catch((error) => {
          failure ??= error;
          return Effect.void;
        }),
      );
    }
    if (failure !== undefined) return yield* Effect.fail(failure);
  });

/**
 * Serialize reuse migration and spawns across current and legacy launchers.
 * Acquiring both locks prevents an old root-layout launcher and a nested-layout
 * launcher from each publishing a daemon for the same default home.
 */
const spawnLocked = (
  options: ResolveDaemonOptions,
): Effect.Effect<DaemonHandle, DaemonLauncherError, DaemonPlatform> =>
  Effect.gen(function* () {
    const directories = launchLockDirectories(options);
    const fileSystem = yield* FileSystem.FileSystem;
    for (const directory of directories) {
      yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new DaemonLaunchError({
              message: `Unable to create ${directory}: ${cause.message}`,
              cause,
            }),
        ),
      );
    }
    const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;

    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const handle = yield* withLocks(directories, replaceOrSpawnDaemon(options)).pipe(
        Effect.mapError((cause) =>
          cause._tag === "DaemonLaunchError" || cause._tag === "DaemonStoppedError"
            ? cause
            : new DaemonLaunchError({
                message: `Unable to acquire the vibest daemon launch lock: ${cause.message}`,
                cause,
              }),
        ),
      );
      if (handle !== undefined) return handle;

      // Another old or current launcher is publishing state. Wait until it
      // records a healthy daemon or releases every relevant lock, then resolve
      // again so compatibility records are reconciled under our locks.
      const winner = yield* waitForRecord(options, timeoutMs);
      if (winner !== undefined) return yield* resolveOrSpawnDaemon(options);
    }
    return yield* Effect.fail(
      new DaemonLaunchError({ message: "Could not acquire the vibest daemon launch lock" }),
    );
  });

/** Poll for a healthy record to appear (a concurrent launcher is spawning). */
const waitForRecord = (
  options: ResolveDaemonOptions,
  timeoutMs: number,
): Effect.Effect<DaemonRecord | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      let locked = false;
      for (const directory of launchLockDirectories(options)) {
        if (yield* lockExists(directory)) {
          locked = true;
          break;
        }
      }
      if (locked) {
        yield* Effect.sleep(HEALTH_POLL_INTERVAL_MS);
        continue;
      }

      const records = yield* readRecords(options.daemonDir, options.legacyDaemonDir);
      for (const { record } of records) {
        if (yield* daemonAlive(record)) return record;
      }
      return undefined;
    }
    return undefined;
  });

const spawnDaemon = (
  options: ResolveDaemonOptions,
): Effect.Effect<DaemonHandle, DaemonLaunchError, DaemonPlatform> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const port = yield* reservePort(options.port ?? DEFAULT_PORT);
    const token = yield* crypto.randomBytes(32).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(
        (cause) => new DaemonLaunchError({ message: "Unable to generate a daemon token", cause }),
      ),
    );
    const address = `http://127.0.0.1:${port}`;

    const pid = yield* Effect.try({
      try: () => spawnDetached(options, port, token),
      catch: (cause) =>
        new DaemonLaunchError({
          message: `Unable to spawn the vibest daemon: ${String(cause)}`,
          cause,
        }),
    });

    // Record the daemon before waiting for health, not after: a launcher that
    // dies mid-wait (the app quitting seconds after first launch) must not
    // orphan an unrecorded daemon — unrecorded means undiscoverable, so
    // nothing can ever attach to it or stop it, and the next launch spawns a
    // second daemon beside it. Readers tolerate a recorded-but-booting daemon:
    // `resolveOrSpawnDaemon` defers to the live launch lock, and
    // `waitForRecord` polls until health answers.
    const record: DaemonRecord = {
      pid,
      address,
      token,
      startedAt: yield* Clock.currentTimeMillis,
      launchOwnerPath: options.launchOwnerPath,
    };
    yield* writeRecords(options.daemonDir, options.legacyDaemonDir, record).pipe(
      Effect.tapError(() =>
        Effect.andThen(killPid(pid), removeRecords(options.daemonDir, options.legacyDaemonDir)),
      ),
    );

    const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    if (!(yield* waitHealthy(address, pid, timeoutMs))) {
      yield* killPid(pid);
      yield* removeRecords(options.daemonDir, options.legacyDaemonDir);
      return yield* Effect.fail(
        new DaemonLaunchError({
          message: `vibest daemon did not become healthy within ${timeoutMs}ms; see ${logsDirectory(options.home)}`,
        }),
      );
    }
    return attach(record, false);
  });

/**
 * The daemon's stdio needs a real file descriptor before the child exists, so
 * this is plain synchronous `node:fs` inside the already-exempt spawn seam.
 *
 * Truncated rather than rotated once it passes the cap. Rotation earns its keep
 * for a log you read; this one holds only what never reached a logger (see
 * `daemon-stdio.log`) and is normally a couple of lines, so an unbounded file
 * would be a disk leak with nothing of value in it.
 */
const STDIO_LOG_MAX_BYTES = 1_000_000;

function openStdioLog(home: string): number {
  const logsDir = logsDirectory(home);
  // Same modes and directory as `Paths.logsDir`. This process is the launcher,
  // not the daemon — the child does not exist yet, so the observability Layer
  // cannot have created `logs/`. Whichever path creates the directory first
  // wins the mode; both must spell the same numbers.
  fs.mkdirSync(logsDir, { recursive: true, mode: LOGS_DIRECTORY_MODE });
  const file = daemonStdioLogPath(logsDir);
  try {
    if (fs.statSync(file).size > STDIO_LOG_MAX_BYTES) fs.truncateSync(file, 0);
  } catch {
    // No file yet, or it cannot be stat'd — `openSync` below decides.
  }
  return fs.openSync(file, "a", LOG_FILE_MODE);
}

/**
 * The one seam Effect cannot model: a detached, unref'd child with stdio
 * redirected to a log fd — the exact opposite of a supervised
 * `ChildProcessSpawner` child (piped stdio, killed when its scope closes).
 * The daemon must outlive this launcher, so this stays raw `node:child_process`
 * — the local `nohup vibest serve > log`.
 */
function spawnDetached(options: ResolveDaemonOptions, port: number, token: string): number {
  const { home, daemonDir } = options;
  const logFd = openStdioLog(home);
  try {
    const [command, ...args] = options.serverArgv;
    if (command === undefined) throw new Error("serverArgv must not be empty");

    const inherited = options.environment ?? process.env;

    const child = childProcess.spawn(command, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        // Extra CORS origins (if any) ride the inherited environment's
        // VIBEST_CORS_ORIGINS — the launcher no longer computes a per-launch
        // set, since the daemon's policy is otherwise static.
        ...inherited,
        VIBEST_HOME: home,
        VIBEST_DAEMON_DIR: daemonDir,
        VIBEST_PORT: String(port),
        VIBEST_AUTH_TOKEN: token,
      },
    });
    child.unref();

    if (child.pid === undefined) throw new Error("Failed to spawn vibest daemon (no pid)");
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

/**
 * Two-signal readiness: the process must still be alive (a crash during boot
 * short-circuits the wait) and answer `/api/health`.
 */
const waitHealthy = (address: string, pid: number, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (!pidAlive(pid)) return false;
      if (yield* healthy(address)) return true;
      yield* Effect.sleep(HEALTH_POLL_INTERVAL_MS);
    }
    return false;
  });

function attach(record: DaemonRecord, reused: boolean): DaemonHandle {
  return {
    address: record.address,
    port: Number(new URL(record.address).port),
    token: record.token,
    pid: record.pid,
    reused,
  };
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}
