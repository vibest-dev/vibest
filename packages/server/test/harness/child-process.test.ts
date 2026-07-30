import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Exit, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

layer(NodeServices.layer)("Effect child process integration", (it) => {
  it.effect("streams stdout and reports the exit code", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("ready\\n")']),
      );
      const output = yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.runCollect,
        Effect.map((chunks) => chunks.join("")),
      );
      const exitCode = yield* handle.exitCode;

      assert.equal(output, "ready\n");
      assert.equal(exitCode, 0);
    }),
  );

  it.effect("terminates the process when its child scope closes", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const childScope = yield* Scope.make();
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
            forceKillAfter: "1 second",
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, childScope));

      assert.equal(yield* handle.isRunning, true);

      yield* Scope.close(childScope, Exit.void);

      assert.equal(yield* handle.isRunning, false);
    }),
  );
});
