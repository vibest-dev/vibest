import assert from "node:assert/strict";
import path from "node:path";

import { layer } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { FileSystemService, FileSystemServiceLayer } from "../src/index";
import { NodePlatformLayer } from "./platform";

layer(FileSystemServiceLayer.pipe(Layer.provideMerge(NodePlatformLayer)))(
  "FileSystemService",
  (it) => {
    const workspace = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-fs-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-out-" });

      yield* fs.writeFileString(path.join(cwd, "a.txt"), "hello\nworld");
      yield* fs.makeDirectory(path.join(cwd, "sub"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "sub", "nested.ts"), "export {};");
      yield* fs.writeFileString(path.join(outside, "secret.txt"), "top secret");
      yield* fs.symlink(path.join(cwd, "a.txt"), path.join(cwd, "internal-link"));
      yield* fs.symlink(path.join(outside, "secret.txt"), path.join(cwd, "outside-link"));
      yield* fs.symlink(outside, path.join(cwd, "outside-dir"));
      yield* fs.symlink(path.join(cwd, "missing.txt"), path.join(cwd, "broken-link"));
      yield* fs.writeFile(path.join(cwd, "bin"), new Uint8Array([104, 0, 105]));
      yield* fs.writeFile(path.join(cwd, "invalid-utf8"), new Uint8Array([0xc3, 0x28]));
      yield* fs.writeFileString(path.join(cwd, "ascii.pdf"), "%PDF-1.4\n1 0 obj\nendobj\n");

      yield* fs.makeDirectory(path.join(cwd, ".git", "objects"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, ".git", "objects", "ignored"), "ignored");
      yield* fs.makeDirectory(path.join(cwd, "node_modules", "pkg", "deep"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(cwd, "node_modules", "pkg", "deep", "ignored.js"),
        "ignored",
      );
      yield* fs.makeDirectory(path.join(cwd, ".yarn", "unplugged", "pkg"), {
        recursive: true,
      });
      yield* fs.writeFileString(path.join(cwd, ".yarn", "unplugged", "pkg", "ignored.js"), "");
      yield* fs.makeDirectory(path.join(cwd, ".yarn", "patches"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, ".yarn", "patches", "keep.patch"), "patch");
      yield* fs.makeDirectory(path.join(cwd, "vendor", "bundle", "gem"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "vendor", "bundle", "gem", "ignored.rb"), "");
      yield* fs.makeDirectory(path.join(cwd, "vendor", "source"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "vendor", "source", "keep.rb"), "puts 'ok'");

      return { cwd, outside };
    });

    const readFile = (cwd: string, relativePath: string) =>
      FileSystemService.use((service) => service.readFileString(cwd, relativePath));

    const readTree = (cwd: string) => FileSystemService.use((service) => service.readTree(cwd));

    const readError = (cwd: string, relativePath: string) =>
      readFile(cwd, relativePath).pipe(
        Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "no-error" }),
      );

    it.effect("reads regular files and in-workspace file symlinks", () =>
      Effect.gen(function* () {
        const { cwd } = yield* workspace;
        assert.equal(yield* readFile(cwd, "a.txt"), "hello\nworld");
        assert.equal(yield* readFile(cwd, "internal-link"), "hello\nworld");
      }),
    );

    it.effect("rejects absolute, traversal, and outside-workspace symlink paths", () =>
      Effect.gen(function* () {
        const { cwd, outside } = yield* workspace;
        assert.equal(
          yield* readError(cwd, path.join(outside, "secret.txt")),
          "WorkspacePathEscape",
        );
        assert.equal(yield* readError(cwd, "../escape.txt"), "WorkspacePathEscape");
        assert.equal(yield* readError(cwd, "outside-link"), "WorkspacePathEscape");
      }),
    );

    it.effect("reports missing, non-file, binary, and oversized files", () =>
      Effect.gen(function* () {
        const { cwd } = yield* workspace;
        assert.equal(yield* readError(cwd, "missing.txt"), "WorkspaceFileNotFound");
        assert.equal(yield* readError(cwd, "sub"), "WorkspaceNotFile");
        assert.equal(yield* readError(cwd, "bin"), "WorkspaceBinaryFile");
        assert.equal(yield* readError(cwd, "invalid-utf8"), "WorkspaceBinaryFile");
        assert.equal(yield* readError(cwd, "ascii.pdf"), "WorkspaceBinaryFile");

        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFile(path.join(cwd, "large.txt"), new Uint8Array(2 * 1024 * 1024 + 1));
        assert.equal(yield* readError(cwd, "large.txt"), "WorkspaceFileTooLarge");
      }),
    );

    it.effect("indexes the complete workspace with approved exclusions", () =>
      Effect.gen(function* () {
        const { cwd } = yield* workspace;
        const tree = yield* readTree(cwd);
        const paths = tree.entries.map((entry) => entry.path);

        assert(paths.includes("sub"));
        assert(paths.includes("sub/nested.ts"));
        assert(paths.includes(".yarn"));
        assert(paths.includes(".yarn/patches/keep.patch"));
        assert(paths.includes("vendor"));
        assert(paths.includes("vendor/source/keep.rb"));

        assert(!paths.some((entry) => entry === ".git" || entry.startsWith(".git/")));
        assert(
          !paths.some((entry) => entry === "node_modules" || entry.startsWith("node_modules/")),
        );
        assert(!paths.some((entry) => entry.startsWith(".yarn/unplugged")));
        assert(!paths.some((entry) => entry.startsWith("vendor/bundle")));
      }),
    );

    it.effect("keeps excluded-looking files and symlinks as visible leaves", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-excluded-leaves-" });
        yield* fs.writeFileString(path.join(cwd, "node_modules"), "not a directory");
        yield* fs.writeFileString(path.join(cwd, "target.txt"), "target");
        yield* fs.symlink(path.join(cwd, "target.txt"), path.join(cwd, ".git"));
        yield* fs.symlink(path.join(cwd, "target.txt"), path.join(cwd, "venv"));

        assert.deepEqual(yield* readTree(cwd), {
          entries: [
            { path: ".git", type: "symlink", symlinkTarget: "file" },
            { path: "node_modules", type: "file" },
            { path: "target.txt", type: "file" },
            { path: "venv", type: "symlink", symlinkTarget: "file" },
          ],
        });
      }),
    );

    it.effect("shows symlinks as classified leaves without traversing directory targets", () =>
      Effect.gen(function* () {
        const { cwd } = yield* workspace;
        const tree = yield* readTree(cwd);
        const symlinks = tree.entries.filter((entry) => entry.type === "symlink");

        assert.deepEqual(symlinks, [
          { path: "broken-link", type: "symlink", symlinkTarget: "broken" },
          { path: "internal-link", type: "symlink", symlinkTarget: "file" },
          { path: "outside-dir", type: "symlink", symlinkTarget: "outside" },
          { path: "outside-link", type: "symlink", symlinkTarget: "outside" },
        ]);
        assert(!tree.entries.some((entry) => entry.path.startsWith("outside-dir/")));
      }),
    );

    it.effect("hides a git worktree metadata file", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-worktree-" });
        yield* fs.writeFileString(path.join(cwd, ".git"), "gitdir: ../metadata");
        yield* fs.writeFileString(path.join(cwd, "visible.ts"), "export {};");

        assert.deepEqual(yield* readTree(cwd), {
          entries: [{ path: "visible.ts", type: "file" }],
        });
      }),
    );

    it.effect("requires an absolute directory workspace root", () =>
      Effect.gen(function* () {
        assert.equal(
          yield* readTree("relative/workspace").pipe(
            Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "no-error" }),
          ),
          "WorkspacePathEscape",
        );
      }),
    );
  },
);
