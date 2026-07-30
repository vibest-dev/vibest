import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitService, GitServiceLayer } from "../src/index";

describe("GitService", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-git-"));
    const git = simpleGit(dir);
    await git.raw(["init", "-b", "main"]);
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test");
    await fs.writeFile(path.join(dir, "a.txt"), "hi");
    await git.add(".");
    await git.commit("init");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, GitService>) =>
    Effect.runPromise(Effect.provide(program, GitServiceLayer));

  it("reports working-tree status with untracked files", async () => {
    await fs.writeFile(path.join(dir, "untracked.txt"), "x");
    const status = await run(
      Effect.gen(function* () {
        const git = yield* GitService;
        return yield* git.status(dir);
      }),
    );
    expect(status.current).toBe("main");
    expect(status.not_added).toContain("untracked.txt");
  });

  it("lists branches", async () => {
    const branch = await run(
      Effect.gen(function* () {
        const git = yield* GitService;
        return yield* git.branch(dir);
      }),
    );
    expect(branch.current).toBe("main");
    expect(branch.all).toContain("main");
  });
});
