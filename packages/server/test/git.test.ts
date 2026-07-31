import assert from "node:assert/strict";
import path from "node:path";

import { layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { simpleGit } from "simple-git";

import { GitService, GitServiceLayer } from "../src/index";
import { NodePlatformLayer } from "./platform";

layer(NodePlatformLayer)("GitService", (it) => {
  /** A repo with one commit on `main`, removed when the test's scope closes. */
  const repo = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-git-" });
    yield* fs.writeFileString(path.join(dir, "a.txt"), "hi");
    yield* Effect.promise(async () => {
      const git = simpleGit(dir);
      await git.raw(["init", "-b", "main"]);
      await git.addConfig("user.email", "test@example.com");
      await git.addConfig("user.name", "Test");
      await git.add(".");
      await git.commit("init");
    });
    return dir;
  });

  it.effect("reports working-tree status with untracked files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* repo;
      yield* fs.writeFileString(path.join(dir, "untracked.txt"), "x");

      const git = yield* GitService;
      const status = yield* git.status(dir);
      assert.equal(status.current, "main");
      assert.ok(status.not_added.includes("untracked.txt"));
    }).pipe(Effect.provide(GitServiceLayer)),
  );

  it.effect("lists branches", () =>
    Effect.gen(function* () {
      const dir = yield* repo;
      const git = yield* GitService;
      const branch = yield* git.branch(dir);
      assert.equal(branch.current, "main");
      assert.ok(branch.all.includes("main"));
    }).pipe(Effect.provide(GitServiceLayer)),
  );
});
