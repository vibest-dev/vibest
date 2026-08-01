import assert from "node:assert/strict";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { releaseLock, tryAcquireLock } from "../../src/daemon/lock";

layer(NodeServices.layer)("daemon lock", (it) => {
  const tempHome = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "vibest-daemon-lock-" })),
  );

  it.effect("serializes launchers through the daemon directory lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;
      const lock = path.join(home, "daemon", "daemon.lock");
      yield* fs.makeDirectory(path.dirname(lock), { recursive: true });

      assert.equal(yield* tryAcquireLock(home), true);
      assert.equal(yield* fs.exists(lock), true);
      assert.equal(yield* tryAcquireLock(home), false);

      yield* releaseLock(home);
      assert.equal(yield* fs.exists(lock), false);
    }),
  );
});
