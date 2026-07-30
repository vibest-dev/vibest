import nodeFs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

describe("fs router", () => {
  it("browses sorted subdirectories with parent, hiding dotfolders and node_modules", async () => {
    const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "vibest-home-"));
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "vibest-browse-"));
    nodeFs.mkdirSync(nodePath.join(dir, "beta"));
    nodeFs.mkdirSync(nodePath.join(dir, "alpha"));
    nodeFs.mkdirSync(nodePath.join(dir, ".hidden"));
    nodeFs.mkdirSync(nodePath.join(dir, "node_modules"));
    const h = await makeRpcTestHarness(home);
    try {
      const listing = await h.client.fs.browse({ path: dir });
      expect(listing.path).toBe(dir);
      expect(listing.parent).toBe(nodePath.dirname(dir));
      expect(listing.directories).toEqual([
        { name: "alpha", path: nodePath.join(dir, "alpha") },
        { name: "beta", path: nodePath.join(dir, "beta") },
      ]);

      const root = await h.client.fs.browse({ path: "/" });
      expect(root.parent).toBeNull();
    } finally {
      await h.dispose();
    }
  });
});
