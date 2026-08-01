import { writeFileAtomic } from "@vibest/effect-json-store";
import { Effect, FileSystem, type PlatformError } from "effect";

import { daemonDirectory, daemonRecordPath } from "./paths";

/**
 * The discovery record the launcher writes to `$VIBEST_DAEMON_DIR/daemon.pid` —
 * the local mirror of the SSH remote's `ssh-launch/<stateKey>/{pid,port,token}`.
 * It is the single-instance marker: staleness is decided by "is the pid alive",
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

/** Discovery record under the configured daemon directory. */
export const recordPath = (home: string, daemonDir?: string): string =>
  daemonRecordPath(daemonDir ?? daemonDirectory(home));

/** Read and validate the record, or `undefined` if missing/garbage. */
export const readRecord = (
  home: string,
  daemonDir?: string,
): Effect.Effect<DaemonRecord | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs
      .readFileString(recordPath(home, daemonDir))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (raw === undefined) return undefined;

    const parsed = yield* Effect.try(() => JSON.parse(raw) as Partial<DaemonRecord>).pipe(
      Effect.orElseSucceed(() => undefined),
    );
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
    return undefined;
  });

/**
 * Atomically write the record with `0600` perms (token is a secret). The
 * shared writer renames a sibling temp file over the target so a concurrent
 * reader never sees a half-written file, and removes the temp file when the
 * write fails or is interrupted.
 */
export const writeRecord = (
  home: string,
  record: DaemonRecord,
  daemonDir?: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    writeFileAtomic(fs, recordPath(home, daemonDir), JSON.stringify(record), { mode: 0o600 }),
  );

/** Remove the record; a missing file is not an error. */
export const removeRecord = (
  home: string,
  daemonDir?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.remove(recordPath(home, daemonDir), { force: true })).pipe(
    Effect.ignore,
  );
