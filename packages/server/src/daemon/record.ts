import { Effect, FileSystem, type PlatformError } from "effect";

import { daemonDirectory, daemonRecordPath, legacyRecordPath } from "./paths";

/**
 * The discovery record the launcher writes to `$VIBEST_HOME/daemon/daemon.pid` — the
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

/** Discovery record under the configured daemon directory. */
export const recordPath = (home: string, daemonHome?: string): string =>
  daemonRecordPath(daemonHome ?? daemonDirectory(home));

const recordPaths = (home: string, daemonHome?: string): ReadonlyArray<string> => [
  recordPath(home, daemonHome),
  ...(daemonHome === undefined ? [legacyRecordPath(home)] : []),
];

const parseRecord = (raw: string): DaemonRecord | undefined => {
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonRecord>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.address === "string" &&
      typeof parsed.token === "string"
    ) {
      return {
        pid: parsed.pid,
        address: parsed.address,
        token: parsed.token,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      };
    }
  } catch {
    // Missing/garbage discovery state is the same as no discoverable daemon.
  }
  return undefined;
};

/** Read every distinct current or legacy record that still parses. */
export const readRecords = (
  home: string,
  daemonHome?: string,
): Effect.Effect<ReadonlyArray<DaemonRecord>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const records: DaemonRecord[] = [];
    for (const file of recordPaths(home, daemonHome)) {
      const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
      if (raw === undefined) continue;
      const record = parseRecord(raw);
      if (
        record !== undefined &&
        !records.some(
          (candidate) => candidate.pid === record.pid && candidate.address === record.address,
        )
      ) {
        records.push(record);
      }
    }
    return records;
  });

/** Read the preferred current record, or the legacy record during migration. */
export const readRecord = (
  home: string,
  daemonHome?: string,
): Effect.Effect<DaemonRecord | undefined, never, FileSystem.FileSystem> =>
  readRecords(home, daemonHome).pipe(Effect.map((records) => records[0]));

/**
 * Atomically write the record with `0600` perms (token is a secret): write a
 * sibling temp file, chmod, then rename over the target so a concurrent reader
 * never sees a half-written file.
 */
export const writeRecord = (
  home: string,
  record: DaemonRecord,
  daemonHome?: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(daemonHome ?? daemonDirectory(home), { recursive: true });
    // The default layout mirrors root-first for mixed-version clients. An
    // explicit daemon home is isolated and never writes into `$VIBEST_HOME`.
    const targets =
      daemonHome === undefined
        ? [legacyRecordPath(home), recordPath(home)]
        : [recordPath(home, daemonHome)];
    for (const target of targets) {
      const tmp = `${target}.${process.pid}.tmp`;
      yield* fs.writeFileString(tmp, JSON.stringify(record), { mode: 0o600 });
      // `mode` only applies when the write creates the file, so a leftover temp
      // from a crashed launcher would otherwise keep its old perms.
      yield* fs.chmod(tmp, 0o600);
      yield* fs.rename(tmp, target);
    }
  });

/** Remove configured and compatibility records; missing files are not errors. */
export const removeRecord = (
  home: string,
  daemonHome?: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    Effect.all(
      recordPaths(home, daemonHome).map((file) => fs.remove(file, { force: true })),
      { discard: true },
    ),
  ).pipe(Effect.ignore);
