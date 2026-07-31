import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { describe } from "vitest";

import { StoreReadError, StoreWriteError } from "../src/errors";
import { readJson, writeJsonAtomic } from "../src/infra/json-store";
import { fakeFileSystem, permissionDenied } from "./fake-file-system";
import { NodePlatformLayer } from "./platform";

/**
 * The repositories' real-fs tests cover the happy path. These pin the error
 * mapping layer instead: which platform failures become which domain error,
 * and which one is silently absorbed into a fallback. A real disk can't be
 * made to deny permission on demand, so the FileSystem is faked here.
 *
 * Every test wants a *different* fake, so there is no block-wide `layer(...)`
 * to bind: the fake is provided inside the body instead.
 */

describe("readJson", () => {
  it.effect("falls back when the file does not exist", () =>
    Effect.gen(function* () {
      const value = yield* readJson("/store/projects.json", ["fallback"]).pipe(
        Effect.provide(fakeFileSystem({})),
      );
      assert.deepEqual(value, ["fallback"]);
    }),
  );

  it.effect("fails with StoreReadError when the file exists but cannot be read", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readJson("/store/projects.json", ["fallback"])).pipe(
        Effect.provide(
          fakeFileSystem({
            readFileString: (path) => Effect.fail(permissionDenied("readFileString", String(path))),
          }),
        ),
      );
      assert.ok(error instanceof StoreReadError);
      assert.equal(error.file, "/store/projects.json");
    }),
  );

  it.effect("fails with StoreReadError when the file holds malformed JSON", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readJson("/store/projects.json", ["fallback"])).pipe(
        Effect.provide(fakeFileSystem({ readFileString: () => Effect.succeed("{ not json") })),
      );
      assert.ok(error instanceof StoreReadError);
    }),
  );
});

describe("writeJsonAtomic", () => {
  const write = (overrides: Partial<FileSystem.FileSystem>) =>
    writeJsonAtomic("/store/projects.json", [{ id: "p1" }]).pipe(
      Effect.provide(Layer.provideMerge(fakeFileSystem(overrides), NodePlatformLayer)),
    );

  /** The failure `writeJsonAtomic` ends with on a FileSystem that misbehaves. */
  const writeWith = (overrides: Partial<FileSystem.FileSystem>) => Effect.flip(write(overrides));

  it.effect("fails with StoreWriteError when the parent directory cannot be created", () =>
    Effect.gen(function* () {
      const error = yield* writeWith({
        makeDirectory: (path) => Effect.fail(permissionDenied("makeDirectory", path)),
      });
      assert.ok(error instanceof StoreWriteError);
      assert.equal(error.file, "/store/projects.json");
    }),
  );

  it.effect("fails with StoreWriteError when the temp file cannot be written", () =>
    Effect.gen(function* () {
      const error = yield* writeWith({
        makeDirectory: () => Effect.void,
        writeFileString: (path) => Effect.fail(permissionDenied("writeFileString", path)),
      });
      assert.ok(error instanceof StoreWriteError);
      // The error names the target, never the temp path the failure happened on.
      assert.equal(error.file, "/store/projects.json");
    }),
  );

  it.effect("fails with StoreWriteError when the rename onto the target fails", () =>
    Effect.gen(function* () {
      const error = yield* writeWith({
        makeDirectory: () => Effect.void,
        writeFileString: () => Effect.void,
        rename: (_, to) => Effect.fail(permissionDenied("rename", to)),
      });
      assert.ok(error instanceof StoreWriteError);
      assert.equal(error.file, "/store/projects.json");
    }),
  );

  it.effect("writes a temp sibling first and renames it onto the target", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* write({
        makeDirectory: (path) => Effect.sync(() => void calls.push(`mkdir ${path}`)),
        writeFileString: (path) => Effect.sync(() => void calls.push(`write ${path}`)),
        rename: (from, to) => Effect.sync(() => void calls.push(`rename ${from} -> ${to}`)),
      });

      assert.equal(calls[0], "mkdir /store");
      // The temp name carries a fresh uuid, so match the shape rather than the id.
      assert.match(calls[1] ?? "", /^write \/store\/projects\.json\..+\.tmp$/);
      assert.match(
        calls[2] ?? "",
        /^rename \/store\/projects\.json\..+\.tmp -> \/store\/projects\.json$/,
      );
    }),
  );
});
