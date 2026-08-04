import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

describe("fs router", () => {
  it("browses sorted subdirectories with parent, including dotfolders only when requested", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-browse-"));
    fs.mkdirSync(path.join(dir, "beta"));
    fs.mkdirSync(path.join(dir, "alpha"));
    fs.mkdirSync(path.join(dir, ".hidden"));
    fs.mkdirSync(path.join(dir, "node_modules"));
    const h = await makeRpcTestHarness(home);
    try {
      const listing = await h.client.fs.browse({ path: dir });
      expect(listing.path).toBe(dir);
      expect(listing.parent).toBe(path.dirname(dir));
      expect(listing.directories).toEqual([
        { name: "alpha", path: path.join(dir, "alpha") },
        { name: "beta", path: path.join(dir, "beta") },
      ]);

      const listingWithHidden = await h.client.fs.browse({ path: dir, includeHidden: true });
      expect(listingWithHidden.directories).toEqual([
        { name: ".hidden", path: path.join(dir, ".hidden") },
        { name: "alpha", path: path.join(dir, "alpha") },
        { name: "beta", path: path.join(dir, "beta") },
      ]);

      const root = await h.client.fs.browse({ path: "/" });
      expect(root.parent).toBeNull();
    } finally {
      await h.dispose();
    }
  });
});
