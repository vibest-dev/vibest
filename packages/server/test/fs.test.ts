import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FSService, FSServiceLayer } from "../src/index";

describe("FSService", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vibest-fs-"));
    await writeFile(join(dir, "a.txt"), "hello\nworld");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "b.txt"), "foobar");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules", "skip.txt"), "ignored");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, FSService>) =>
    Effect.runPromise(Effect.provide(program, FSServiceLayer));

  it("reads a file", async () => {
    const content = await run(
      Effect.gen(function* () {
        const fs = yield* FSService;
        return yield* fs.readFile(join(dir, "a.txt"));
      }),
    );
    expect(content).toBe("hello\nworld");
  });

  it("trees files recursively, skipping node_modules", async () => {
    const tree = await run(
      Effect.gen(function* () {
        const fs = yield* FSService;
        return yield* fs.tree(dir);
      }),
    );
    expect(new Set(tree)).toEqual(new Set(["a.txt", join("sub", "b.txt")]));
  });

  it("greps file contents", async () => {
    const matches = await run(
      Effect.gen(function* () {
        const fs = yield* FSService;
        return yield* fs.grep("world", dir);
      }),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ file: "a.txt", line: 2, text: "world" });
  });

  it("searches file paths by name", async () => {
    const found = await run(
      Effect.gen(function* () {
        const fs = yield* FSService;
        return yield* fs.search("b.txt", dir);
      }),
    );
    expect(found).toEqual([join("sub", "b.txt")]);
  });
});
