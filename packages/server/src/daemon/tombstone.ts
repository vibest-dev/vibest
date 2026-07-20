import fs from "node:fs";
import path from "node:path";

/**
 * The stop tombstone — `$VIBEST_HOME/daemon.stopped`, written by an explicit
 * `stopDaemon` so automatic supervision (the desktop's respawn loop) does not
 * resurrect a daemon the user deliberately stopped. An explicit start clears
 * it. Its mere existence is the signal; the timestamp is only for debugging.
 */
function tombstonePath(home: string): string {
  return path.join(home, "daemon.stopped");
}

export function hasTombstone(home: string): boolean {
  return fs.existsSync(tombstonePath(home));
}

export function writeTombstone(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tombstonePath(home), String(Date.now()), { mode: 0o600 });
}

export function clearTombstone(home: string): void {
  try {
    fs.rmSync(tombstonePath(home));
  } catch {
    // already gone
  }
}
