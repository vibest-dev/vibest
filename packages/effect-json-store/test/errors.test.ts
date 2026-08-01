import assert from "node:assert/strict";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Schema } from "effect";

import { makeJsonDocument } from "../src";
import { withTmp } from "./helpers";

const schema = Schema.Struct({ theme: Schema.String });
const defaults = { theme: "light" };

const openWithFileContent = (content: string) =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      yield* fs.writeFileString(file, content);
      return yield* Effect.flip(makeJsonDocument({ path: file, schema, defaults }));
    }),
  );

it.effect("fails with JsonStoreParseError on invalid JSON and never resets the file", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      yield* fs.writeFileString(file, "{ not json");
      const error = yield* Effect.flip(makeJsonDocument({ path: file, schema, defaults }));
      assert.equal(error._tag, "JsonStoreParseError");
      assert.equal(yield* fs.readFileString(file), "{ not json");
    }),
  ),
);

it.effect("fails with JsonStoreFormatError when the envelope has no version", () =>
  Effect.gen(function* () {
    const error = yield* openWithFileContent(JSON.stringify({ theme: "dark" }));
    assert.equal(error._tag, "JsonStoreFormatError");
  }),
);

it.effect("fails with JsonStoreFormatError when the version is not a positive integer", () =>
  Effect.gen(function* () {
    const error = yield* openWithFileContent(
      JSON.stringify({ version: 0, data: { theme: "dark" } }),
    );
    assert.equal(error._tag, "JsonStoreFormatError");
  }),
);

it.effect("fails with JsonStoreVersionTooNewError and leaves the file untouched", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      const original = JSON.stringify({ version: 2, data: { theme: "dark" } });
      yield* fs.writeFileString(file, original);
      const error = yield* Effect.flip(makeJsonDocument({ path: file, schema, defaults }));
      assert.equal(error._tag, "JsonStoreVersionTooNewError");
      assert.equal(error._tag === "JsonStoreVersionTooNewError" && error.fileVersion, 2);
      assert.equal(error._tag === "JsonStoreVersionTooNewError" && error.latestVersion, 1);
      assert.equal(yield* fs.readFileString(file), original);
    }),
  ),
);

it.effect("fails with JsonStoreDecodeError when latest-version data fails its schema", () =>
  Effect.gen(function* () {
    const error = yield* openWithFileContent(JSON.stringify({ version: 1, data: { theme: 42 } }));
    assert.equal(error._tag, "JsonStoreDecodeError");
  }),
);

it.effect("fails with JsonStoreWriteError when the encoded value is not JSON-serializable", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const AnyValue = Schema.Struct({ value: Schema.Unknown });
      const store = yield* makeJsonDocument({
        path: path.join(dir, "config.json"),
        schema: AnyValue,
        defaults: { value: 1 },
      });
      // BigInt slips through Schema.Unknown but JSON.stringify rejects it.
      const error = yield* Effect.flip(store.set({ value: 1n }));
      assert.equal(error._tag, "JsonStoreWriteError");
    }),
  ),
);

it.effect("fails with JsonStoreWriteError on rename failure, leaving no temp file", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      const original = JSON.stringify({ version: 1, data: { theme: "dark" } });
      yield* real.writeFileString(file, original);
      const failingRename: FileSystem.FileSystem = {
        ...real,
        rename: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename",
            }),
          ),
      };
      const store = yield* makeJsonDocument({ path: file, schema, defaults }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingRename),
      );
      const error = yield* Effect.flip(store.set({ theme: "light" }));
      assert.equal(error._tag, "JsonStoreWriteError");
      // The original document is untouched and the failed write's temp file is gone.
      assert.equal(yield* real.readFileString(file), original);
      assert.deepEqual(yield* real.readDirectory(dir), ["config.json"]);
    }),
  ),
);

/** Real filesystem for reads, but every write fails — for write-error injection. */
const failingWrites = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    return {
      ...real,
      writeFileString: () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "writeFileString",
          }),
        ),
    };
  }),
).pipe(Layer.provide(NodeFileSystem.layer));

it.effect(
  "fails with JsonStoreWriteError when seeding cannot write, keeping migrations atomic",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "config.json");

      // Seed write fails.
      const seedError = yield* Effect.flip(
        makeJsonDocument({ path: file, schema, defaults }).pipe(Effect.provide(failingWrites)),
      );
      assert.equal(seedError._tag, "JsonStoreWriteError");

      // A migration whose write-back fails leaves the old file byte-identical.
      const original = JSON.stringify({ version: 1, data: { theme: "dark" } });
      yield* fs.writeFileString(file, original);
      const V2 = Schema.Struct({ theme: Schema.String, fontSize: Schema.Number });
      const migrateError = yield* Effect.flip(
        makeJsonDocument({
          path: file,
          schema: V2,
          migrations: [{ schema, migrate: (prev) => ({ ...prev, fontSize: 14 }) }],
          defaults: { theme: "x", fontSize: 1 },
        }).pipe(Effect.provide(failingWrites)),
      );
      assert.equal(migrateError._tag, "JsonStoreWriteError");
      assert.equal(yield* fs.readFileString(file), original);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
