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

export type DaemonHandle = {
  readonly address: string;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  /** True when an already-running daemon was attached to instead of spawned. */
  readonly reused: boolean;
};

export type ResolveDaemonOptions = {
  /** `$VIBEST_HOME` — owns `daemon.pid` and `daemon.log`. */
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
 * the CLI and (later) the desktop go through here so there is exactly one
 * daemon per `$VIBEST_HOME`.
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
    if (missing.length === 0) return attach(existing, true);
    await stopDaemon(options.home);
    return spawnDaemon({
      ...options,
      corsOrigins: [...new Set([...existing.corsOrigins, ...requested])],
    });
  }
  // A record whose pid/health no longer holds is stale — clear it before we
  // claim the slot, so a crashed daemon never blocks a restart.
  if (existing) removeRecord(options.home);
  return spawnDaemon(options);
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
 * Stop the daemon: SIGTERM, wait for it to exit, escalate to SIGKILL if it
 * overstays, then clear the record. Returns whether anything was running.
 */
export async function stopDaemon(home: string): Promise<"stopped" | "not-running"> {
  const record = readRecord(home);
  if (!record || !pidAlive(record.pid)) {
    removeRecord(home);
    return "not-running";
  }

  signal(record.pid, "SIGTERM");
  const deadline = now() + STOP_GRACE_MS;
  while (now() < deadline && pidAlive(record.pid)) {
    await delay(100);
  }
  if (pidAlive(record.pid)) signal(record.pid, "SIGKILL");

  removeRecord(home);
  return "stopped";
}

async function spawnDaemon(options: ResolveDaemonOptions): Promise<DaemonHandle> {
  const { home } = options;
  fs.mkdirSync(home, { recursive: true });

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
