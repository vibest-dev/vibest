import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { StoreReadError, StoreWriteError } from "../src/errors";
import { readJson, writeJsonAtomic } from "../src/infra/json-store";
import { fakeFileSystem, permissionDenied } from "./fake-file-system";
import { NodePlatformLayer } from "./platform";

/**
 * The repositories' real-fs tests cover the happy path. These pin the error
 * mapping layer instead: which platform failures become which domain error,
 * and which one is silently absorbed into a fallback. A real disk can't be
 * made to deny permission on demand, so the FileSystem is faked here.
 */

const run = <A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem>,
  fs: Layer.Layer<FileSystem.FileSystem>,
) => Effect.runPromise(Effect.provide(program, fs));

describe("readJson", () => {
  it("falls back when the file does not exist", async () => {
    const value = await run(readJson("/store/projects.json", ["fallback"]), fakeFileSystem({}));
    expect(value).toEqual(["fallback"]);
  });

  it("fails with StoreReadError when the file exists but cannot be read", async () => {
    const error = await run(
      Effect.flip(readJson("/store/projects.json", ["fallback"])),
      fakeFileSystem({
        readFileString: (path) => Effect.fail(permissionDenied("readFileString", String(path))),
      }),
    );
    expect(error).toBeInstanceOf(StoreReadError);
    expect(error.file).toBe("/store/projects.json");
  });

  it("fails with StoreReadError when the file holds malformed JSON", async () => {
    const error = await run(
      Effect.flip(readJson("/store/projects.json", ["fallback"])),
      fakeFileSystem({ readFileString: () => Effect.succeed("{ not json") }),
    );
    expect(error).toBeInstanceOf(StoreReadError);
  });
});

describe("writeJsonAtomic", () => {
  const withFailure = (overrides: Partial<FileSystem.FileSystem>) =>
    Layer.provideMerge(fakeFileSystem(overrides), NodePlatformLayer);

  /** The failure `writeJsonAtomic` ends with on a FileSystem that misbehaves. */
  const writeWith = (overrides: Partial<FileSystem.FileSystem>) =>
    Effect.runPromise(
      Effect.provide(
        Effect.flip(writeJsonAtomic("/store/projects.json", [{ id: "p1" }])),
        withFailure(overrides),
      ),
    );

  it("fails with StoreWriteError when the parent directory cannot be created", async () => {
    const error = await writeWith({
      makeDirectory: (path) => Effect.fail(permissionDenied("makeDirectory", path)),
    });
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.file).toBe("/store/projects.json");
  });

  it("fails with StoreWriteError when the temp file cannot be written", async () => {
    const error = await writeWith({
      makeDirectory: () => Effect.void,
      writeFileString: (path) => Effect.fail(permissionDenied("writeFileString", path)),
    });
    expect(error).toBeInstanceOf(StoreWriteError);
    // The error names the target, never the temp path the failure happened on.
    expect(error.file).toBe("/store/projects.json");
  });

  it("fails with StoreWriteError when the rename onto the target fails", async () => {
    const error = await writeWith({
      makeDirectory: () => Effect.void,
      writeFileString: () => Effect.void,
      rename: (_, to) => Effect.fail(permissionDenied("rename", to)),
    });
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.file).toBe("/store/projects.json");
  });

  it("writes a temp sibling first and renames it onto the target", async () => {
    const calls: Array<string> = [];
    const recording = fakeFileSystem({
      makeDirectory: (path) => Effect.sync(() => void calls.push(`mkdir ${path}`)),
      writeFileString: (path) => Effect.sync(() => void calls.push(`write ${path}`)),
      rename: (from, to) => Effect.sync(() => void calls.push(`rename ${from} -> ${to}`)),
    });

    await Effect.runPromise(
      Effect.provide(
        writeJsonAtomic("/store/projects.json", [{ id: "p1" }]),
        Layer.provideMerge(recording, NodePlatformLayer),
      ),
    );

    expect(calls[0]).toBe("mkdir /store");
    // The temp name carries a fresh uuid, so match the shape rather than the id.
    expect(calls[1]).toMatch(/^write \/store\/projects\.json\..+\.tmp$/);
    expect(calls[2]).toMatch(
      /^rename \/store\/projects\.json\..+\.tmp -> \/store\/projects\.json$/,
    );
  });
});
