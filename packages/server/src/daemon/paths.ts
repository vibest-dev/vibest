import path from "node:path";

/**
 * The four lifecycle files, named relative to a daemon directory the caller
 * already resolved. Deliberately no default of its own — see
 * `resolveDaemonLocation` in `config/paths.ts`.
 */

/** Discovery record — pid, address, and the daemon's auth token. */
export const daemonRecordPath = (daemonDir: string): string => path.join(daemonDir, "daemon.pid");

/** Exclusive-create launch lock, held only while a launcher is spawning. */
export const daemonLockPath = (daemonDir: string): string => path.join(daemonDir, "daemon.lock");

/** The detached daemon's stdout/stderr. */
export const daemonLogPath = (daemonDir: string): string => path.join(daemonDir, "daemon.log");

/** Written by an explicit stop so supervision does not resurrect the daemon. */
export const daemonTombstonePath = (daemonDir: string): string =>
  path.join(daemonDir, "daemon.stopped");
