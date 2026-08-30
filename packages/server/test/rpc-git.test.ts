import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

describe("git router", () => {
  it("models repository availability instead of failing the probe", async () => {
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
      await expect(harness.client.git.branch({ cwd: repo })).resolves.toEqual({
        kind: "repository",
        current: "main",
      });
      await expect(harness.client.git.branch({ cwd: bare })).resolves.toEqual({
        kind: "not-repository",
      });
      await expect(harness.client.git.branch({ cwd: path.join(bare, "missing") })).resolves.toEqual(
        {
          kind: "workspace-unavailable",
        },
      );
    } finally {
      await harness.dispose();
    }
  });
});
