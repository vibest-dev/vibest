import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { daemonAlive, healthy, pidAlive } from "./liveness";
import { reservePort } from "./port";
import { type DaemonRecord, readRecord, removeRecord, writeRecord } from "./record";

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

/**
 * Thrown when an auto-respawn caller finds the `daemon.stopped` tombstone: the
 * user explicitly stopped the daemon and automatic supervision must not undo
 * that. An explicit start (CLI `vibest daemon start`, app launch) clears it.
 */
export class DaemonStoppedError extends Error {
  override readonly name = "DaemonStoppedError";
}

export type ResolveDaemonOptions = {
  /** `$VIBEST_HOME` — owns `daemon.pid`, `daemon.log`, and the launch lock. */
  readonly home: string;
  /**
   * argv that launches the plain foreground server, e.g.
   * `[process.execPath, ...process.execArgv, cliEntry, "serve"]`. The daemon is
   * just this command spawned detached — the server stays daemon-unaware.
   */
  readonly serverArgv: readonly string[];
  /** Preferred port; falls back to an ephemeral one if taken. Default `4000`. */
  readonly port?: number;
  readonly corsOrigins?: readonly string[];
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

/** `$VIBEST_HOME`, falling back to `~/.vibest` — mirrors the server's Paths. */
export function resolveVibestHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.VIBEST_HOME ?? path.join(os.homedir(), ".vibest");
}

/**
 * The shared launcher (the local twin of the SSH launch script): read
 * `daemon.pid`; if a healthy daemon is there, attach; otherwise spawn the
 * foreground server detached, wait for it to answer health, and record it. Both
 * the CLI and the desktop go through here so there is exactly one daemon per
 * `$VIBEST_HOME` — concurrent launchers are serialized by an exclusive-create
 * launch lock, and the loser attaches to the winner's daemon.
 */
export async function resolveOrSpawnDaemon(options: ResolveDaemonOptions): Promise<DaemonHandle> {
  const requested = options.corsOrigins ?? [];
  const existing = readRecord(options.home);

  if (existing && (await daemonAlive(existing))) {
    // The one daemon must serve every client's origins. If this client needs
    // origins the running daemon wasn't started with (e.g. the desktop's
    // app:// origin joining a CLI-started daemon), converge by restarting it
    // with the union — CORS is fixed at server boot, so a restart is the only
    // way. This happens at most once per new origin set.
    const missing = requested.filter((origin) => !existing.corsOrigins.includes(origin));
    if (missing.length === 0) {
      // A live daemon makes any tombstone stale (someone started it again).
      clearTombstone(options.home);
      return attach(existing, true);
    }
    await killPid(existing.pid);
    removeRecord(options.home);
    return spawnLocked({
      ...options,
      corsOrigins: unionOrigins(existing.corsOrigins, requested),
    });
  }

  if (options.autoRespawn === true && hasTombstone(options.home)) {
    throw new DaemonStoppedError(
      "vibest daemon was stopped explicitly; not auto-respawning (run `vibest daemon start` to start it again)",
    );
  }
  clearTombstone(options.home);

  if (existing) {
    // Wedged (pid alive but unhealthy) daemons must die before we replace
    // them, or they leak as orphans still holding their port. A dead pid is
    // a no-op here.
    await killPid(existing.pid);
    removeRecord(options.home);
  }
  // Preserve the origins other clients negotiated into the record even across
  // a crash respawn — a respawn must never narrow the daemon's CORS.
  return spawnLocked({
    ...options,
    corsOrigins: existing ? unionOrigins(existing.corsOrigins, requested) : requested,
  });
}

/** Read the current daemon's status without starting one. */
export async function statusDaemon(
  home: string,
): Promise<{ readonly running: boolean; readonly record?: DaemonRecord }> {
  const record = readRecord(home);
  if (record && (await daemonAlive(record))) return { running: true, record };
  return { running: false };
}

/**
 * Stop the daemon and leave a `daemon.stopped` tombstone so automatic
 * supervision (the desktop's respawn loop) does not resurrect it. The
 * tombstone is written before the kill so a respawn racing the stop still
 * sees it. Returns whether anything was running.
 */
export async function stopDaemon(home: string): Promise<"stopped" | "not-running"> {
  const record = readRecord(home);
  if (!record || !pidAlive(record.pid)) {
    removeRecord(home);
    return "not-running";
  }

  writeTombstone(home);
  await killPid(record.pid);
  removeRecord(home);
  return "stopped";
}

/** SIGTERM, wait up to the grace period, escalate to SIGKILL. */
async function killPid(pid: number): Promise<void> {
  if (!pidAlive(pid)) return;
  signal(pid, "SIGTERM");
  const deadline = now() + STOP_GRACE_MS;
  while (now() < deadline && pidAlive(pid)) {
    await delay(100);
  }
  if (pidAlive(pid)) signal(pid, "SIGKILL");
}

function unionOrigins(
  recorded: readonly string[],
  requested: readonly string[],
): readonly string[] {
  return [...new Set([...recorded, ...requested])];
}

function lockPath(home: string): string {
  return path.join(home, "daemon.lock");
}

function tombstonePath(home: string): string {
  return path.join(home, "daemon.stopped");
}

function hasTombstone(home: string): boolean {
  return fs.existsSync(tombstonePath(home));
}

function writeTombstone(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tombstonePath(home), String(now()), { mode: 0o600 });
}

function clearTombstone(home: string): void {
  try {
    fs.rmSync(tombstonePath(home));
  } catch {
    // already gone
  }
}

/**
 * Serialize spawns with an exclusive-create lock file so two launchers racing
 * an empty `$VIBEST_HOME` (or a respawn window) cannot both spawn a daemon —
 * the loser waits for the winner's record and attaches. The lock holds the
 * holder's pid; a lock whose holder died is reclaimed.
 */
async function spawnLocked(options: ResolveDaemonOptions): Promise<DaemonHandle> {
  const { home } = options;
  fs.mkdirSync(home, { recursive: true });
  const lock = lockPath(home);
  const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLockPid(lock);
      if (holder !== undefined && !pidAlive(holder)) {
        // The locking launcher died mid-spawn; reclaim and try again.
        try {
          fs.rmSync(lock);
        } catch {
          // lost the reclaim race — loop
        }
        continue;
      }
      // Another launcher is spawning right now: wait for its daemon, then
      // re-enter the full resolve so this caller's own origin requirements
      // are still enforced against the winner's daemon (origins only grow,
      // so the recursion converges).
      const winner = await waitForRecord(home, timeoutMs);
      if (winner) return resolveOrSpawnDaemon(options);
      continue;
    }

    try {
      return await spawnDaemon(options);
    } finally {
      try {
        fs.rmSync(lock);
      } catch {
        // already gone
      }
    }
  }
  throw new Error("Could not acquire the vibest daemon launch lock");
}

function readLockPid(lock: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(lock, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Poll for a healthy record to appear (a concurrent launcher is spawning). */
async function waitForRecord(home: string, timeoutMs: number): Promise<DaemonRecord | undefined> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const record = readRecord(home);
    if (record && (await daemonAlive(record))) return record;
    if (!fs.existsSync(lockPath(home))) return undefined;
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
  return undefined;
}

async function spawnDaemon(options: ResolveDaemonOptions): Promise<DaemonHandle> {
  const { home } = options;

  const port = await reservePort(options.port ?? DEFAULT_PORT);
  const token = crypto.randomBytes(32).toString("hex");
  const address = `http://127.0.0.1:${port}`;

  // Detached, streams to a log file (never a pipe to us): the daemon must
  // outlive this short-lived launcher. This is `nohup vibest serve > log`,
  // done locally instead of over SSH.
  const logFd = fs.openSync(path.join(home, "daemon.log"), "a", 0o600);
  const [command, ...args] = options.serverArgv;
  if (command === undefined) throw new Error("serverArgv must not be empty");

  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...(options.environment ?? process.env),
      VIBEST_HOME: home,
      VIBEST_PORT: String(port),
      VIBEST_AUTH_TOKEN: token,
      VIBEST_CORS_ORIGINS: (options.corsOrigins ?? []).join(","),
    },
  });
  fs.closeSync(logFd);
  child.unref();

  const { pid } = child;
  if (pid === undefined) throw new Error("Failed to spawn vibest daemon (no pid)");

  const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  if (!(await waitHealthy(address, pid, timeoutMs))) {
    signal(pid, "SIGTERM");
    throw new Error(
      `vibest daemon did not become healthy within ${timeoutMs}ms; see ${path.join(home, "daemon.log")}`,
    );
  }

  const record: DaemonRecord = {
    pid,
    address,
    token,
    corsOrigins: options.corsOrigins ?? [],
    startedAt: now(),
  };
  writeRecord(home, record);
  return attach(record, false);
}

/**
 * Two-signal readiness: the process must still be alive (a crash during boot
 * short-circuits the wait) and answer `/api/health`.
 */
async function waitHealthy(address: string, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!pidAlive(pid)) return false;
    if (await healthy(address)) return true;
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

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

function now(): number {
  return Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
