import { writeFileAtomic } from "@vibest/effect-json-store";
import { Effect, FileSystem, type PlatformError } from "effect";

import { daemonRecordPath } from "./paths";

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

/** Read and validate the record, or `undefined` if missing/garbage. */
export const readRecord = (
  daemonDir: string,
): Effect.Effect<DaemonRecord | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs
      .readFileString(daemonRecordPath(daemonDir))
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
  daemonDir: string,
  record: DaemonRecord,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    writeFileAtomic(fs, daemonRecordPath(daemonDir), JSON.stringify(record), { mode: 0o600 }),
  );

/** Remove the record; a missing file is not an error. */
export const removeRecord = (
  daemonDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.remove(daemonRecordPath(daemonDir), { force: true })).pipe(
    Effect.ignore,
  );
