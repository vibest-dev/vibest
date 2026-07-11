import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { GitService, GitServiceLayer } from "../src/index";

describe("GitService", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vibest-git-"));
    const git = simpleGit(dir);
    await git.raw(["init", "-b", "main"]);
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test");
    await writeFile(join(dir, "a.txt"), "hi");
    await git.add(".");
    await git.commit("init");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, GitService>) =>
    Effect.runPromise(Effect.provide(program, GitServiceLayer));

  it("reports working-tree status with untracked files", async () => {
    await writeFile(join(dir, "untracked.txt"), "x");
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
