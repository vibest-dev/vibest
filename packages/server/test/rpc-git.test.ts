import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

describe("git router", () => {
  it("returns the current branch for a work tree and null otherwise", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-git-"));
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-nogit-"));
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    const git = simpleGit(repo);
    await git.raw(["init", "-b", "main"]);
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test");
    await git.add(".");
    await git.commit("init");

    const harness = await makeRpcTestHarness(home);
    try {
      await expect(harness.client.git.branch({ cwd: repo })).resolves.toEqual({ current: "main" });
      await expect(harness.client.git.branch({ cwd: bare })).resolves.toEqual({ current: null });
    } finally {
      await harness.dispose();
    }
  });
});
