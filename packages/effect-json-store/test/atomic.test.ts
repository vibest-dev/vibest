import assert from "node:assert/strict";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, PlatformError } from "effect";

import { writeFileAtomic } from "../src";
import { withTmp } from "./helpers";

const renameError = PlatformError.systemError({
  _tag: "PermissionDenied",
  module: "FileSystem",
  method: "rename",
});

it.effect("replaces the destination atomically and leaves no temp file", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      yield* fs.writeFileString(file, "old");
      yield* writeFileAtomic(fs, file, "new");
      assert.equal(yield* fs.readFileString(file), "new");
      assert.deepEqual(yield* fs.readDirectory(dir), ["config.json"]);
    }),
  ),
);

it.effect("rename failure keeps the original bytes and removes the temp file", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const failing: FileSystem.FileSystem = {
        ...real,
        rename: () => Effect.fail(renameError),
      };
      const file = path.join(dir, "config.json");
      yield* real.writeFileString(file, "original");
      const error = yield* Effect.flip(writeFileAtomic(failing, file, "next"));
      assert.equal(error.reason._tag, "PermissionDenied");
      assert.equal(yield* real.readFileString(file), "original");
      assert.deepEqual(yield* real.readDirectory(dir), ["config.json"]);
    }),
  ),
);

it.effect("interruption after the temp write leaves no temp file", () =>
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    const dir = yield* Effect.orDie(real.makeTempDirectoryScoped());
    const renameStarted = yield* Deferred.make<void>();
    // Rename never completes; by the time it starts, the temp file is on disk.
    const hanging: FileSystem.FileSystem = {
      ...real,
      rename: () => Effect.andThen(Deferred.succeed(renameStarted, undefined), Effect.never),
    };
    const file = path.join(dir, "config.json");
    const fiber = yield* Effect.forkScoped(writeFileAtomic(hanging, file, "next"));
    yield* Deferred.await(renameStarted);
    yield* Fiber.interrupt(fiber);
    assert.deepEqual(yield* real.readDirectory(dir), []);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
