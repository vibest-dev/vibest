import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

describe("rpc defect boundary", () => {
  it("turns an unexpected failure into a generic internal error carrying a log ref", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-ws-"));
    const h = await makeRpcTestHarness(home);
    try {
      const project = await h.client.project.create({ path: workspace });
      // A corrupt record in the project's own directory fails the listing —
      // an infrastructure failure no caller can act on, so the wire must see
      // only the generic error + ref, never the parse detail.
      const dir = path.join(home, "storage", "sessions", project.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "corrupt.json"), "{not json");

      const error = await h.client.session.list({ projectId: project.id }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect((error as Error).message).toMatch(/ref err_[0-9a-f]{8}/);
      expect((error as Error).message).not.toContain("corrupt.json");
    } finally {
      await h.dispose();
    }
  });
});
