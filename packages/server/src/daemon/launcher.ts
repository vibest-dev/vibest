import childProcess from "node:child_process";
import fs from "node:fs";

import { Clock, Crypto, Effect, Encoding, FileSystem, type PlatformError } from "effect";

import {
  daemonStdioLogPath,
  LOG_FILE_MODE,
  LOGS_DIRECTORY_MODE,
  logsDirectory,
} from "../config/paths";
import { DaemonLaunchError, DaemonStoppedError } from "./errors";
import { daemonAlive, healthy, pidAlive } from "./liveness";
import { lockExists, readLockPid, releaseLock, tryAcquireLock } from "./lock";
import { reservePort } from "./port";
import { type DaemonRecord, readRecord, removeRecord, writeRecord } from "./record";
import { clearTombstone, hasTombstone, writeTombstone } from "./tombstone";

const DEFAULT_PORT = 4000;
const READY_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 150;
const STOP_GRACE_MS = 5_000;
const LOCK_ATTEMPTS = 10;

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
   * argv that launches the plain foreground server, e.g.
   * `[process.execPath, ...process.execArgv, cliEntry, "serve"]`. The daemon is
   * just this command spawned detached — the server stays daemon-unaware.
   */
  readonly serverArgv: readonly string[];
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
 * `daemon/daemon.pid`; if a healthy daemon is there, attach; otherwise spawn the
 * foreground server detached, record it, and wait for it to answer health. Both
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
export const resolveOrSpawnDaemon = (
  options: ResolveDaemonOptions,
): Effect.Effect<DaemonHandle, DaemonLauncherError, DaemonPlatform> =>
  Effect.gen(function* () {
    const existing = yield* readRecord(options.daemonDir);
    if (existing !== undefined && (yield* daemonAlive(existing))) {
      // A live daemon makes any tombstone stale (someone started it again).
      yield* clearTombstone(options.daemonDir);
      return attach(existing, true);
    }

    if (options.autoRespawn === true && (yield* hasTombstone(options.daemonDir))) {
      return yield* Effect.fail(
        new DaemonStoppedError({
          message:
            "vibest daemon was stopped explicitly; not auto-respawning (run `vibest daemon start` to start it again)",
        }),
      );
    }
    yield* clearTombstone(options.daemonDir);

    if (existing !== undefined) {
      // The record lands before the health wait, so an unhealthy record with a
      // live lock holder is a daemon still booting under another launcher —
      // defer to `spawnLocked`'s wait instead of killing it mid-boot. Without
      // a live holder it is wedged (pid alive but unhealthy) or dead, and must
      // die before we replace it, or it leaks as an orphan still holding its
      // port. A dead pid makes the kill a no-op.
      const holder = yield* readLockPid(options.daemonDir);
      if (holder === undefined || !pidAlive(holder)) {
        yield* killPid(existing.pid);
        yield* removeRecord(options.daemonDir);
      }
    }
    return yield* spawnLocked(options);
  });

/** Read the current daemon's status without starting one. */
export const statusDaemon = (
  daemonDir: string,
): Effect.Effect<
  { readonly running: false } | { readonly running: true; readonly record: DaemonRecord },
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const record = yield* readRecord(daemonDir);
    return record === undefined || !(yield* daemonAlive(record))
      ? { running: false }
      : { running: true, record };
  });

/**
 * Stop the daemon and leave a `daemon.stopped` tombstone so automatic
 * supervision (the desktop's respawn loop) does not resurrect it. The
 * tombstone is written before the kill so a respawn racing the stop still
 * sees it. Returns whether anything was running.
 */
export const stopDaemon = (
  daemonDir: string,
): Effect.Effect<"stopped" | "not-running", PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const record = yield* readRecord(daemonDir);
    if (record === undefined || !pidAlive(record.pid)) {
      yield* removeRecord(daemonDir);
      return "not-running";
    }

    yield* writeTombstone(daemonDir);
    yield* killPid(record.pid);
    yield* removeRecord(daemonDir);
    return "stopped";
  });

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
 * Serialize spawns with the launch lock (see `lock.ts`) so two launchers racing
 * an empty daemon directory (or a respawn window) cannot both spawn a daemon —
 * the loser waits for the winner's record and attaches. A lock whose holder pid
 * died is reclaimed. `ensuring` releases the lock even when the spawn is
 * interrupted.
 */
const spawnLocked = (
  options: ResolveDaemonOptions,
): Effect.Effect<DaemonHandle, DaemonLauncherError, DaemonPlatform> =>
  Effect.gen(function* () {
    const { daemonDir } = options;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(daemonDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DaemonLaunchError({
            message: `Unable to create ${daemonDir}: ${cause.message}`,
            cause,
          }),
      ),
    );
    const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;

    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      // The exclusive create is still one atomic syscall, so making the
      // surrounding steps async moves no decision: only the winner proceeds to
      // spawn, and every other branch below already assumes the file state can
      // change under it (a reclaim can lose its race, and the retry loop is
      // what covers that).
      const acquired = yield* tryAcquireLock(daemonDir).pipe(
        Effect.mapError(
          (cause) =>
            new DaemonLaunchError({
              message: `Unable to acquire the vibest daemon launch lock: ${cause.message}`,
              cause,
            }),
        ),
      );

      if (!acquired) {
        const holder = yield* readLockPid(daemonDir);
        if (holder !== undefined && !pidAlive(holder)) {
          // The locking launcher died mid-spawn; reclaim and try again.
          yield* releaseLock(daemonDir);
          continue;
        }
        // Another launcher is spawning right now: wait for its daemon, then
        // re-enter the full resolve so this caller attaches to the winner's
        // daemon (which by then is recorded and healthy).
        const winner = yield* waitForRecord(daemonDir, timeoutMs);
        if (winner) return yield* resolveOrSpawnDaemon(options);
        continue;
      }

      return yield* spawnDaemon(options).pipe(Effect.ensuring(releaseLock(daemonDir)));
    }
    return yield* Effect.fail(
      new DaemonLaunchError({ message: "Could not acquire the vibest daemon launch lock" }),
    );
  });

/** Poll for a healthy record to appear (a concurrent launcher is spawning). */
const waitForRecord = (
  daemonDir: string,
  timeoutMs: number,
): Effect.Effect<DaemonRecord | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const record = yield* readRecord(daemonDir);
      if (record !== undefined && (yield* daemonAlive(record))) return record;
      if (!(yield* lockExists(daemonDir))) return undefined;
      yield* Effect.sleep(HEALTH_POLL_INTERVAL_MS);
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
    };
    yield* writeRecord(options.daemonDir, record).pipe(
      Effect.mapError(
        (cause) =>
          new DaemonLaunchError({
            message: `Unable to record the vibest daemon: ${cause.message}`,
            cause,
          }),
      ),
      Effect.tapError(() => Effect.andThen(killPid(pid), removeRecord(options.daemonDir))),
    );

    const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    if (!(yield* waitHealthy(address, pid, timeoutMs))) {
      yield* killPid(pid);
      yield* removeRecord(options.daemonDir);
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
