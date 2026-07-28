import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

describe("fs router", () => {
  it("browses sorted subdirectories with parent, hiding dotfolders and node_modules", async () => {
    const home = mkdtempSync(join(tmpdir(), "vibest-home-"));
    const dir = mkdtempSync(join(tmpdir(), "vibest-browse-"));
    mkdirSync(join(dir, "beta"));
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, ".hidden"));
    mkdirSync(join(dir, "node_modules"));
    const h = await makeRpcTestHarness(home);
    try {
      const listing = await h.client.fs.browse({ path: dir });
      expect(listing.path).toBe(dir);
      expect(listing.parent).toBe(dirname(dir));
      expect(listing.directories).toEqual([
        { name: "alpha", path: join(dir, "alpha") },
        { name: "beta", path: join(dir, "beta") },
      ]);

      const root = await h.client.fs.browse({ path: "/" });
      expect(root.parent).toBeNull();
    } finally {
      await h.dispose();
    }
  });
});
