import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSystemService, FileSystemServiceLayer } from "../src/index";

describe("FileSystemService", () => {
  let cwd: string;
  let outside: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "vibest-fs-"));
    outside = await mkdtemp(join(tmpdir(), "vibest-out-"));
    await writeFile(join(cwd, "a.txt"), "hello\nworld");
    await mkdir(join(cwd, "sub"), { recursive: true });
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(cwd, "link"));
    await writeFile(join(cwd, "bin"), Buffer.from([104, 0, 105])); // "h\0i"
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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

  const readFile = (path: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystemService;
      return yield* fs.readFileString(cwd, path);
    });

  it("reads a file relative to cwd", async () => {
    expect(await run(readFile("a.txt"))).toBe("hello\nworld");
  });

  it("rejects an absolute path", async () => {
    expect(await errorTag(readFile(join(outside, "secret.txt")))).toBe("WorkspacePathEscape");
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
