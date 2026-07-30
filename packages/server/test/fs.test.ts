import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSystemService, FileSystemServiceLayer } from "../src/index";

describe("FileSystemService", () => {
  let cwd: string;
  let outside: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-fs-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-out-"));
    await fs.writeFile(path.join(cwd, "a.txt"), "hello\nworld");
    await fs.mkdir(path.join(cwd, "sub"), { recursive: true });
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(cwd, "link"));
    await fs.writeFile(path.join(cwd, "bin"), Buffer.from([104, 0, 105])); // "h\0i"
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, FileSystemService>) =>
    Effect.runPromise(Effect.provide(program, FileSystemServiceLayer));

  // Run a program expected to fail and surface the error's `_tag` (or a sentinel
  // if it unexpectedly succeeds).
  const errorTag = <A, E extends { readonly _tag: string }>(
    program: Effect.Effect<A, E, FileSystemService>,
  ) =>
    run(
      program.pipe(
        Effect.match({
          onFailure: (e) => e._tag,
          onSuccess: () => "no-error",
        }),
      ),
    );

  const readFile = (relPath: string) =>
    Effect.gen(function* () {
      const service = yield* FileSystemService;
      return yield* service.readFileString(cwd, relPath);
    });

  it("reads a file relative to cwd", async () => {
    expect(await run(readFile("a.txt"))).toBe("hello\nworld");
  });

  it("rejects an absolute path", async () => {
    expect(await errorTag(readFile(path.join(outside, "secret.txt")))).toBe("WorkspacePathEscape");
  });

  it("rejects a `..` escape", async () => {
    expect(await errorTag(readFile("../escape.txt"))).toBe("WorkspacePathEscape");
  });

  it("rejects a symlink pointing outside cwd", async () => {
    expect(await errorTag(readFile("link"))).toBe("WorkspacePathEscape");
  });

  it("rejects a directory read as a file", async () => {
    expect(await errorTag(readFile("sub"))).toBe("WorkspaceNotFile");
  });

  it("rejects a binary file", async () => {
    expect(await errorTag(readFile("bin"))).toBe("WorkspaceBinaryFile");
  });
});
