import type { DaemonRecord } from "./record";

/** True if a process with this pid exists (signal 0 probes without killing). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True if `${address}/api/health` answers `ok`. */
export async function healthy(address: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/health", address), { signal });
    return res.ok && (await res.text()) === "ok";
  } catch {
    return false;
  }
}

/**
 * Two-signal liveness: the recorded pid is running AND the recorded address
 * answers health. Either alone is insufficient — a reused pid may be a foreign
 * process, and a stale address may be a different server.
 */
export async function daemonAlive(record: DaemonRecord): Promise<boolean> {
  return pidAlive(record.pid) && (await healthy(record.address));
}
