import assert from "node:assert/strict";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { releaseLock, tryAcquireLock } from "../../src/daemon/lock";

layer(NodeServices.layer)("daemon lock", (it) => {
  const tempDaemonDir = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "vibest-daemon-lock-" })),
  );

  it.effect("serializes launchers through the daemon directory lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const daemonDir = yield* tempDaemonDir;
      const lock = path.join(daemonDir, "daemon.lock");

      assert.equal(yield* tryAcquireLock(daemonDir), true);
      assert.equal(yield* fs.exists(lock), true);
      assert.equal(yield* tryAcquireLock(daemonDir), false);

      yield* releaseLock(daemonDir);
      assert.equal(yield* fs.exists(lock), false);
    }),
  );

  it.effect("locks in two daemon directories do not exclude each other", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* tempDaemonDir;
      const [first, second] = [path.join(root, "a"), path.join(root, "b")];
      yield* Effect.forEach([first, second], (dir) => fs.makeDirectory(dir, { recursive: true }));

      assert.equal(yield* tryAcquireLock(first), true);
      assert.equal(yield* tryAcquireLock(second), true);
    }),
  );
});
