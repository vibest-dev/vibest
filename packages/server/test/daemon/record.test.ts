import assert from "node:assert/strict";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, FileSystem, PlatformError } from "effect";

import { daemonRecordPath } from "../../src/daemon/paths";
import { type DaemonRecord, readRecord, removeRecord, writeRecord } from "../../src/daemon/record";

const record: DaemonRecord = {
  pid: 4321,
  address: "http://127.0.0.1:41234",
  token: "sekret",
  startedAt: 1_700_000_000_000,
  launchOwnerPath: "/tmp/vibest-owner",
};

layer(NodeServices.layer)("daemon record", (it) => {
  // `it.effect` bodies are scoped, so the temp directory is removed when the
  // test ends however it ends — no afterEach.
  const tempDaemonDir = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "vibest-daemon-" })),
  );

  it.effect("round-trips through daemon.pid", () =>
    Effect.gen(function* () {
      const daemonDir = yield* tempDaemonDir;
      yield* writeRecord(daemonDir, record);
      assert.deepEqual(yield* readRecord(daemonDir), record);
    }),
  );

  it.effect("writes daemon.pid inside the daemon directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const daemonDir = yield* tempDaemonDir;
      yield* writeRecord(daemonDir, record);
      assert.equal(daemonRecordPath(daemonDir), path.join(daemonDir, "daemon.pid"));
      assert.ok(yield* fs.exists(daemonRecordPath(daemonDir)));
    }),
  );

  // Windows does not honor unix perms; the token is only a secret on posix.
  it.effect.skipIf(process.platform === "win32")("writes daemon.pid with 0600 perms", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const daemonDir = yield* tempDaemonDir;
      yield* writeRecord(daemonDir, record);
      const info = yield* fs.stat(daemonRecordPath(daemonDir));
      assert.equal((info.mode ?? 0) & 0o777, 0o600);
    }),
  );

  it.effect("reads legacy records without a launch owner path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const daemonDir = yield* tempDaemonDir;
      const legacy = {
        pid: record.pid,
        address: record.address,
        token: record.token,
        startedAt: record.startedAt,
      };
      yield* fs.writeFileString(daemonRecordPath(daemonDir), JSON.stringify(legacy));
      assert.deepEqual(yield* readRecord(daemonDir), legacy);
    }),
  );

  it.effect("returns undefined when the record is missing", () =>
    Effect.gen(function* () {
      const daemonDir = yield* tempDaemonDir;
      assert.equal(yield* readRecord(daemonDir), undefined);
    }),
  );

  it.effect("returns undefined for a garbage or incomplete record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const daemonDir = yield* tempDaemonDir;

      yield* fs.writeFileString(daemonRecordPath(daemonDir), "not json");
      assert.equal(yield* readRecord(daemonDir), undefined);

      yield* fs.writeFileString(daemonRecordPath(daemonDir), JSON.stringify({ pid: 1 }));
      assert.equal(yield* readRecord(daemonDir), undefined);
    }),
  );

  it.effect("a failed rename keeps the old record and leaves no temp file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const daemonDir = yield* tempDaemonDir;
      yield* writeRecord(daemonDir, record);
      const original = yield* fs.readFileString(daemonRecordPath(daemonDir));
      const failingRename: FileSystem.FileSystem = {
        ...fs,
        rename: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename",
            }),
          ),
      };
      const error = yield* Effect.flip(
        writeRecord(daemonDir, { ...record, pid: 9999 }).pipe(
          Effect.provideService(FileSystem.FileSystem, failingRename),
        ),
      );
      assert.equal(error.reason._tag, "PermissionDenied");
      assert.equal(yield* fs.readFileString(daemonRecordPath(daemonDir)), original);
      assert.deepEqual(yield* fs.readDirectory(daemonDir), ["daemon.pid"]);
    }),
  );

  it.effect("removeRecord is a no-op when the file is already gone", () =>
    Effect.gen(function* () {
      const daemonDir = yield* tempDaemonDir;
      yield* removeRecord(daemonDir);
      yield* writeRecord(daemonDir, record);
      yield* removeRecord(daemonDir);
      assert.equal(yield* readRecord(daemonDir), undefined);
    }),
  );
});
