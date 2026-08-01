import path from "node:path";

/** Default daemon state directory for a `$VIBEST_HOME`. */
export const daemonDirectory = (home: string): string => path.join(home, "daemon");

export const daemonRecordPath = (daemonHome: string): string => path.join(daemonHome, "daemon.pid");

export const daemonLockPath = (daemonHome: string): string => path.join(daemonHome, "daemon.lock");

export const daemonLogPath = (daemonHome: string): string => path.join(daemonHome, "daemon.log");

export const daemonTombstonePath = (daemonHome: string): string =>
  path.join(daemonHome, "daemon.stopped");

// Compatibility with homes created before daemon lifecycle files moved under
// the default `$VIBEST_HOME/daemon/` directory. These mirrors are used only
// when VIBEST_DAEMON_DIR is absent.
export const legacyRecordPath = (home: string): string => path.join(home, "daemon.pid");
export const legacyLockPath = (home: string): string => path.join(home, "daemon.lock");
export const legacyTombstonePath = (home: string): string => path.join(home, "daemon.stopped");
