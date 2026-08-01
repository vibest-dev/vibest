import path from "node:path";

/** Default daemon state directory for a `$VIBEST_HOME`. */
export const daemonDirectory = (home: string): string => path.join(home, "daemon");

export const daemonRecordPath = (daemonDir: string): string => path.join(daemonDir, "daemon.pid");

export const daemonLockPath = (daemonDir: string): string => path.join(daemonDir, "daemon.lock");

export const daemonLogPath = (daemonDir: string): string => path.join(daemonDir, "daemon.log");

export const daemonTombstonePath = (daemonDir: string): string =>
  path.join(daemonDir, "daemon.stopped");
