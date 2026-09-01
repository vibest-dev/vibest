import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

async function makeRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-rpc-git-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "hi\n");
  const git = simpleGit(dir);
  await git.raw(["init", "-b", "main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  await git.add(".");
  await git.commit("init");
  return dir;
}

describe("git router", () => {
  it("returns the current branch for a work tree", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const cwd = await makeRepo();
    const harness = await makeRpcTestHarness(home);
    try {
      await expect(harness.client.git.branch({ cwd })).resolves.toMatchObject({
        current: "main",
        defaultBranch: "main",
        branches: ["main"],
        remotes: [],
      });
    } finally {
      await harness.dispose();
    }
  });

  it("reviews uncommitted changes and returns a file diff", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const cwd = await makeRepo();
    fs.writeFileSync(path.join(cwd, "a.txt"), "hello\n");
    const harness = await makeRpcTestHarness(home);
    try {
      const review = await harness.client.git.review({ cwd });
      expect(review.mode).toBe("uncommitted");
      expect(review.other).toBeNull();
      expect(review.branch).toBe("main");
      expect(review.base).toBe("HEAD");
      expect(review.baseBranch).toBeNull();
      expect(review.files).toEqual([{ path: "a.txt", status: "modified" }]);

      const diff = await harness.client.git.diff({ cwd, path: "a.txt" });
      expect(diff.oldContents).toBe("hi\n");
      expect(diff.newContents).toBe("hello\n");
    } finally {
      await harness.dispose();
    }
  });

  it("maps a missing compare ref to REF_NOT_FOUND", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const cwd = await makeRepo();
    const harness = await makeRpcTestHarness(home);
    try {
      await expect(
        harness.client.git.review({ cwd, mode: "branch", other: "nope" }),
      ).rejects.toMatchObject({
        code: "REF_NOT_FOUND",
        data: { ref: "nope" },
      });
    } finally {
      await harness.dispose();
    }
  });

  it("maps a non-repository and a relative cwd to typed errors", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-not-git-"));
    const harness = await makeRpcTestHarness(home);
    try {
      await expect(harness.client.git.review({ cwd: dir })).rejects.toMatchObject({
        code: "NOT_REPOSITORY",
        data: { cwd: dir },
      });
      await expect(harness.client.git.status({ cwd: "relative/workspace" })).rejects.toMatchObject({
        code: "PATH_ESCAPE",
        data: { cwd: "relative/workspace", path: "." },
      });
    } finally {
      await harness.dispose();
    }
  });
});
