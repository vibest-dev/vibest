import assert from "node:assert/strict";

import { layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { installCrashHandler } from "../../src/telemetry/crash";
import { logFileFor } from "../../src/telemetry/paths";
import { NodePlatformLayer } from "../platform";

/**
 * `uncaughtExceptionMonitor` is an ordinary emitter event, so a crash can be
 * simulated by emitting it — no child process, and no actually killing the
 * test runner. The cast is because `@types/node` types `emit` off the
 * `uncaughtException` overload.
 */
const simulateCrash = (error: Error): void => {
  process.emit("uncaughtExceptionMonitor" as "uncaughtException", error);
};

const readToday = (fs: FileSystem.FileSystem, directory: string) =>
  fs.readFileString(logFileFor(directory, new Date()));

layer(NodePlatformLayer, { excludeTestServices: true })("crash handler", (it) => {
  it.effect("writes the last words into the same JSONL as everything else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installCrashHandler(directory);
          simulateCrash(new Error("kaboom"));
        }),
      );

      const parsed = JSON.parse((yield* readToday(fs, directory)).trim());
      assert.equal(parsed.level, "FATAL");
      assert.equal(parsed.annotations.event, "process.crashed");
      assert.equal(parsed.pid, process.pid);
      // The stack, not just the message — this is the one log line that has to
      // stand on its own, because nothing runs after it.
      assert.ok(String(parsed.cause).includes("kaboom"));
      assert.ok(String(parsed.cause).includes("crash.test"));
    }),
  );

  // Written synchronously precisely because the batched logger's flush fiber
  // never gets a turn once the process is on its way out.
  it.effect("writes without waiting for any flush window", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installCrashHandler(directory);
          simulateCrash(new Error("immediate"));
          // Read back inside the same scope, with no sleep at all.
          const content = yield* readToday(fs, directory);
          assert.ok(content.includes("immediate"));
        }),
      );
    }),
  );

  it.effect("stops listening once its scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installCrashHandler(directory);
          simulateCrash(new Error("first"));
        }),
      );
      const afterScope = yield* readToday(fs, directory);

      simulateCrash(new Error("second"));

      assert.equal(yield* readToday(fs, directory), afterScope);
      assert.ok(!afterScope.includes("second"));
    }),
  );
});
