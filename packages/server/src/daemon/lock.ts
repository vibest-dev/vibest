import fs from "node:fs";
import path from "node:path";

/**
 * The launch lock — an exclusive-create `$VIBEST_HOME/daemon.lock` holding the
 * acquiring launcher's pid. It serializes spawns so two launchers racing an
 * empty home (or a respawn window) cannot both spawn a daemon; the loser waits
 * for the winner's record and attaches. A lock whose holder pid has died is
 * reclaimable. This is the file-state seam; the retry/wait orchestration lives
 * in the launcher.
 */
function lockPath(home: string): string {
  return path.join(home, "daemon.lock");
}

/** Create the lock atomically. True when acquired; false when someone holds it. */
export function tryAcquireLock(home: string): boolean {
  try {
    fs.writeFileSync(lockPath(home), String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** The pid recorded in the lock, or `undefined` if missing/garbage. */
export function readLockPid(home: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath(home), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the lock still exists (a concurrent launcher is still spawning). */
export function lockExists(home: string): boolean {
  return fs.existsSync(lockPath(home));
}

/** Release the lock; a missing lock (or a lost reclaim race) is not an error. */
export function releaseLock(home: string): void {
  try {
    fs.rmSync(lockPath(home));
  } catch {
    // already gone (or lost a reclaim race — the retry loop handles it)
  }
}
