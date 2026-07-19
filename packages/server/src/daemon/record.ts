import fs from "node:fs";
import path from "node:path";

/**
 * The discovery record the launcher writes to `$VIBEST_HOME/daemon.pid` — the
 * local mirror of the SSH remote's `ssh-launch/<stateKey>/{pid,port,token}`. It
 * is the single-instance marker: staleness is decided by "is the pid alive",
 * never a lock the server holds. The server itself never reads or writes it.
 */
export type DaemonRecord = {
  /** The detached server process's pid. */
  readonly pid: number;
  /** Where the daemon listens, e.g. `http://127.0.0.1:41234`. */
  readonly address: string;
  /** The auth token the daemon was started with; front-doors read it from here. */
  readonly token: string;
  /** Epoch millis the record was written. */
  readonly startedAt: number;
};

/** `$VIBEST_HOME/daemon.pid`. */
export function recordPath(home: string): string {
  return path.join(home, "daemon.pid");
}

/** Read and validate the record, or `undefined` if missing/garbage. */
export function readRecord(home: string): DaemonRecord | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath(home), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonRecord>;
    if (
      typeof parsed?.pid === "number" &&
      typeof parsed?.address === "string" &&
      typeof parsed?.token === "string"
    ) {
      return {
        pid: parsed.pid,
        address: parsed.address,
        token: parsed.token,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      };
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Atomically write the record with `0600` perms (token is a secret): write a
 * sibling temp file, chmod, then rename over the target so a concurrent reader
 * never sees a half-written file.
 */
export function writeRecord(home: string, record: DaemonRecord): void {
  fs.mkdirSync(home, { recursive: true });
  const target = recordPath(home);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
}

/** Remove the record; a missing file is not an error. */
export function removeRecord(home: string): void {
  try {
    fs.rmSync(recordPath(home));
  } catch {
    // already gone
  }
}
