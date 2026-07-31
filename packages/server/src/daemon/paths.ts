import path from "node:path";

/** `$VIBEST_HOME/daemon/` — lifecycle state for the one daemon owning this home. */
export const daemonDirectory = (home: string): string => path.join(home, "daemon");

export const recordPath = (home: string): string => path.join(daemonDirectory(home), "daemon.pid");

export const lockPath = (home: string): string => path.join(daemonDirectory(home), "daemon.lock");

export const logPath = (home: string): string => path.join(daemonDirectory(home), "daemon.log");

export const tombstonePath = (home: string): string =>
  path.join(daemonDirectory(home), "daemon.stopped");

// Compatibility with homes created before daemon lifecycle files moved under
// `$VIBEST_HOME/daemon/`. Discovery, locking, and stop signals are mirrored at
// these paths so mixed old/new launchers still converge on one daemon.
export const legacyRecordPath = (home: string): string => path.join(home, "daemon.pid");
export const legacyLockPath = (home: string): string => path.join(home, "daemon.lock");
export const legacyTombstonePath = (home: string): string => path.join(home, "daemon.stopped");
