import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

describe("fs router", () => {
  it("reads files and indexes a confined workspace", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-workspace-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-outside-"));
    fs.mkdirSync(path.join(cwd, "src"));
    fs.mkdirSync(path.join(cwd, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "README.md"), "# Hello");
    fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export {};");
    fs.writeFileSync(path.join(cwd, "node_modules", "pkg", "ignored.js"), "ignored");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(cwd, "README.md"), path.join(cwd, "readme-link"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(cwd, "outside-link"));

    const harness = await makeRpcTestHarness(home);
    try {
      await expect(harness.client.fs.readFileString({ cwd, path: "README.md" })).resolves.toBe(
        "# Hello",
      );
      await expect(harness.client.fs.readFileString({ cwd, path: "readme-link" })).resolves.toBe(
        "# Hello",
      );
      const tree = await harness.client.fs.readTree({ cwd });
      expect(tree.entries).toEqual(
        expect.arrayContaining([
          { path: "outside-link", type: "symlink", symlinkTarget: "outside" },
          { path: "README.md", type: "file" },
          { path: "readme-link", type: "symlink", symlinkTarget: "file" },
          { path: "src", type: "directory" },
          { path: "src/index.ts", type: "file" },
        ]),
      );
      expect(tree.entries.some((entry) => entry.path.startsWith("node_modules"))).toBe(false);
      await expect(
        harness.client.fs.readFileString({ cwd, path: "outside-link" }),
      ).rejects.toMatchObject({
        code: "PATH_ESCAPE",
        data: { cwd, path: "outside-link" },
      });
      await expect(
        harness.client.fs.readFileString({ cwd, path: "missing.txt" }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        data: { path: "missing.txt" },
      });
      await expect(harness.client.fs.readTree({ cwd: "relative/workspace" })).rejects.toMatchObject(
        {
          code: "PATH_ESCAPE",
          data: { cwd: "relative/workspace", path: "." },
        },
      );
    } finally {
      await harness.dispose();
    }
  });

  it("browses sorted subdirectories with parent, including dotfolders only when requested", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-browse-"));
    fs.mkdirSync(path.join(dir, "beta"));
    fs.mkdirSync(path.join(dir, "alpha"));
    fs.mkdirSync(path.join(dir, ".hidden"));
    fs.mkdirSync(path.join(dir, "node_modules"));
    const harness = await makeRpcTestHarness(home);
    try {
      const listing = await harness.client.fs.browse({ path: dir });
      expect(listing.path).toBe(dir);
      expect(listing.parent).toBe(path.dirname(dir));
      expect(listing.directories).toEqual([
        { name: "alpha", path: path.join(dir, "alpha") },
        { name: "beta", path: path.join(dir, "beta") },
      ]);

      const listingWithHidden = await harness.client.fs.browse({ path: dir, includeHidden: true });
      expect(listingWithHidden.directories).toEqual([
        { name: ".hidden", path: path.join(dir, ".hidden") },
        { name: "alpha", path: path.join(dir, "alpha") },
        { name: "beta", path: path.join(dir, "beta") },
      ]);

      const root = await harness.client.fs.browse({ path: "/" });
      expect(root.parent).toBeNull();
    } finally {
      await harness.dispose();
    }
  });
});
