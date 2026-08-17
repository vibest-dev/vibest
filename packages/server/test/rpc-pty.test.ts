import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeRpcTestHarness } from "./rpc-harness";

describe("pty router", () => {
  it("spawns a shell, echoes output, and deletes the session", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-pty-ws-"));
    const harness = await makeRpcTestHarness(home);
    try {
      const project = await harness.client.project.create({ path: workspace });
      const created = await harness.client.pty.create({
        projectId: project.id,
        cols: 80,
        rows: 24,
      });
      expect(created.projectId).toBe(project.id);
      await expect(harness.client.pty.list({ projectId: project.id })).resolves.toEqual([created]);
      await expect(harness.client.pty.get({ ptyId: created.ptyId })).resolves.toMatchObject({
        ptyId: created.ptyId,
      });

      const iterator = await harness.client.pty.subscribe({ ptyId: created.ptyId });
      const chunks: string[] = [];
      const collected = (async () => {
        for await (const event of iterator) {
          if (event.type === "data") chunks.push(event.data);
          if (chunks.join("").includes("hello-pty")) return;
        }
      })();
      await harness.client.pty.write({ ptyId: created.ptyId, data: "echo hello-pty\n" });
      await Promise.race([
        collected,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`no echo in ${chunks.join("")}`)), 8_000);
        }),
      ]);
      expect(chunks.join("")).toContain("hello-pty");

      await harness.client.pty.delete({ ptyId: created.ptyId });
      await expect(harness.client.pty.get({ ptyId: created.ptyId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("maps unknown ids and missing projects", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
    const harness = await makeRpcTestHarness(home);
    try {
      await expect(
        harness.client.pty.create({
          projectId: "00000000-0000-4000-8000-000000000000",
          cols: 80,
          rows: 24,
        }),
      ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
      await expect(harness.client.pty.get({ ptyId: "missing" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      await harness.dispose();
    }
  });
});
