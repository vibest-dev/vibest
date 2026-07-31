import assert from "node:assert/strict";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, FileSystem, PlatformError } from "effect";

import {
  type DaemonRecord,
  readRecord,
  recordPath,
  removeRecord,
  writeRecord,
} from "../../src/daemon/record";

const record: DaemonRecord = {
  pid: 4321,
  address: "http://127.0.0.1:41234",
  token: "sekret",
  startedAt: 1_700_000_000_000,
};

layer(NodeServices.layer)("daemon record", (it) => {
  // `it.effect` bodies are scoped, so the temp home is removed when the test
  // ends however it ends — no afterEach.
  const tempHome = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "vibest-daemon-" })),
  );

  it.effect("round-trips through daemon.pid", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* writeRecord(home, record);
      assert.deepEqual(yield* readRecord(home), record);
    }),
  );

  it.effect("writes daemon.pid at the expected path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;
      yield* writeRecord(home, record);
      assert.equal(recordPath(home), path.join(home, "daemon.pid"));
      assert.ok(yield* fs.exists(recordPath(home)));
    }),
  );

  // Windows does not honor unix perms; the token is only a secret on posix.
  it.effect.skipIf(process.platform === "win32")("writes daemon.pid with 0600 perms", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;
      yield* writeRecord(home, record);
      const info = yield* fs.stat(recordPath(home));
      assert.equal((info.mode ?? 0) & 0o777, 0o600);
    }),
  );

  it.effect("returns undefined when the record is missing", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      assert.equal(yield* readRecord(home), undefined);
    }),
  );

  it.effect("returns undefined for a garbage or incomplete record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;

      yield* fs.writeFileString(recordPath(home), "not json");
      assert.equal(yield* readRecord(home), undefined);

      yield* fs.writeFileString(recordPath(home), JSON.stringify({ pid: 1 }));
      assert.equal(yield* readRecord(home), undefined);
    }),
  );

  it.effect("a failed rename keeps the old record and leaves no temp file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;
      yield* writeRecord(home, record);
      const original = yield* fs.readFileString(recordPath(home));
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
        writeRecord(home, { ...record, pid: 9999 }).pipe(
          Effect.provideService(FileSystem.FileSystem, failingRename),
        ),
      );
      assert.equal(error.reason._tag, "PermissionDenied");
      assert.equal(yield* fs.readFileString(recordPath(home)), original);
      assert.deepEqual(yield* fs.readDirectory(home), ["daemon.pid"]);
    }),
  );

  it.effect("removeRecord is a no-op when the file is already gone", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* removeRecord(home);
      yield* writeRecord(home, record);
      yield* removeRecord(home);
      assert.equal(yield* readRecord(home), undefined);
    }),
  );
});
