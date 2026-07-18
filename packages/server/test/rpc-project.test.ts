import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

describe("project router", () => {
  it("creates a project named after the folder, dedupes by path, and lists it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vibest-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "vibest-project-"));
    const h = makeRpcTestHarness(home);
    try {
      const created = await h.client.project.create({ path: workspace });
      expect(created).toMatchObject({ name: basename(workspace), path: workspace });

      const again = await h.client.project.create({ path: workspace });
      expect(again.id).toBe(created.id);

      await expect(h.client.project.list()).resolves.toEqual([created]);
    } finally {
      await h.dispose();
    }
  });

  it("browses sorted subdirectories with parent, hiding dotfolders and node_modules", async () => {
    const home = mkdtempSync(join(tmpdir(), "vibest-home-"));
    const dir = mkdtempSync(join(tmpdir(), "vibest-browse-"));
    mkdirSync(join(dir, "beta"));
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, ".hidden"));
    mkdirSync(join(dir, "node_modules"));
    const h = makeRpcTestHarness(home);
    try {
      const listing = await h.client.project.listDirectories({ path: dir });
      expect(listing.path).toBe(dir);
      expect(listing.parent).toBe(dirname(dir));
      expect(listing.directories).toEqual([
        { name: "alpha", path: join(dir, "alpha") },
        { name: "beta", path: join(dir, "beta") },
      ]);

      const root = await h.client.project.listDirectories({ path: "/" });
      expect(root.parent).toBeNull();
    } finally {
      await h.dispose();
    }
  });
});
