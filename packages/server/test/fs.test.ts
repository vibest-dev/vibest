import assert from "node:assert/strict";
import path from "node:path";

import { layer } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { FileSystemService, FileSystemServiceLayer } from "../src/index";
import { NodePlatformLayer } from "./platform";

layer(FileSystemServiceLayer.pipe(Layer.provideMerge(NodePlatformLayer)))(
  "FileSystemService",
  (it) => {
    /**
     * A workspace and a directory outside it, both removed with the test. `link`
     * points across the boundary — the escape every read has to refuse.
     */
    const workspace = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-fs-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-out-" });
      yield* fs.writeFileString(path.join(cwd, "a.txt"), "hello\nworld");
      yield* fs.makeDirectory(path.join(cwd, "sub"), { recursive: true });
      yield* fs.writeFileString(path.join(outside, "secret.txt"), "top secret");
      yield* fs.symlink(path.join(outside, "secret.txt"), path.join(cwd, "link"));
      yield* fs.writeFile(path.join(cwd, "bin"), new Uint8Array([104, 0, 105])); // "h\0i"
      return { cwd, outside };
    });

    const readFile = (cwd: string, relPath: string) =>
      FileSystemService.use((service) => service.readFileString(cwd, relPath));

    /** The `_tag` of the refusal, or a sentinel if the read unexpectedly worked. */
    const readError = (cwd: string, relPath: string) =>
      readFile(cwd, relPath).pipe(
        Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "no-error" }),
      );

    it.effect("reads a file relative to cwd", () =>
      Effect.gen(function* () {
        const { cwd } = yield* workspace;
        assert.equal(yield* readFile(cwd, "a.txt"), "hello\nworld");
      }),
    );

    it.effect("rejects an absolute path", () =>
      Effect.gen(function* () {
        const { cwd, outside } = yield* workspace;
        assert.equal(
          yield* readError(cwd, path.join(outside, "secret.txt")),
          "WorkspacePathEscape",
        );
      }),
    );

    it.effect("rejects a `..` escape", () =>
      Effect.gen(function* () {
        const { cwd } = yield* workspace;
        assert.equal(yield* readError(cwd, "../escape.txt"), "WorkspacePathEscape");
      }),
    );

    it.effect("rejects a symlink pointing outside cwd", () =>
      Effect.gen(function* () {
        const { cwd } = yield* workspace;
        assert.equal(yield* readError(cwd, "link"), "WorkspacePathEscape");
      }),
    );

    it.effect("rejects a directory read as a file", () =>
      Effect.gen(function* () {
        const { cwd } = yield* workspace;
        assert.equal(yield* readError(cwd, "sub"), "WorkspaceNotFile");
      }),
    );

    it.effect("rejects a binary file", () =>
      Effect.gen(function* () {
        const { cwd } = yield* workspace;
        assert.equal(yield* readError(cwd, "bin"), "WorkspaceBinaryFile");
      }),
    );
  },
);
