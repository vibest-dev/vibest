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

  it.effect("uses the legacy root lock as the mixed-version exclusion point", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;
      const legacyLock = path.join(home, "daemon.lock");
      const nestedLock = path.join(home, "daemon", "daemon.lock");
      yield* fs.makeDirectory(path.dirname(nestedLock), { recursive: true });
      yield* fs.writeFileString(legacyLock, String(process.pid), { mode: 0o600 });

      assert.equal(yield* tryAcquireLock(home), false);
      assert.equal(yield* fs.exists(nestedLock), false);

      yield* fs.remove(legacyLock);
      assert.equal(yield* tryAcquireLock(home), true);
      assert.equal(yield* fs.exists(legacyLock), true);
      assert.equal(yield* fs.exists(nestedLock), true);

      yield* releaseLock(home);
      assert.equal(yield* fs.exists(legacyLock), false);
      assert.equal(yield* fs.exists(nestedLock), false);
    }),
  );
});
