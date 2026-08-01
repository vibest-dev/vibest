import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { HarnessAgentAdapter } from "../src/harness";
import { makeFakeAdapter } from "./fake-adapter";
import { makeRpcTestHarness } from "./rpc-harness";

describe("harness router", () => {
  it("lists every harness's availability and permission subset in one call", async () => {
    const adapters: ReadonlyArray<HarnessAgentAdapter> = [
      makeFakeAdapter({
        id: "claude-code",
        name: "Claude Code",
        available: true,
        permissionModes: ["plan", "ask", "acceptEdits", "full"],
      }),
      makeFakeAdapter({
        id: "codex",
        name: "Codex",
        available: false,
        reason: "codex CLI not found",
        permissionModes: ["read-only", "ask", "full"],
      }),
      makeFakeAdapter({ id: "pi", name: "Pi", available: true }),
    ];
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-rpc-harness-"));
    const { client, dispose } = await makeRpcTestHarness(home, adapters);
    try {
      const { harnessAgents } = await client.harness.list({});

      expect(harnessAgents.map((agent) => agent.id)).toEqual(["claude-code", "codex", "pi"]);

      const claude = harnessAgents.find((agent) => agent.id === "claude-code");
      expect(claude).toMatchObject({ name: "Claude Code", available: true });
      expect(claude?.reason).toBeUndefined();
      expect(claude?.permissionModes).toEqual(["plan", "ask", "acceptEdits", "full"]);

      const codex = harnessAgents.find((agent) => agent.id === "codex");
      expect(codex).toMatchObject({ available: false, reason: "codex CLI not found" });

      const pi = harnessAgents.find((agent) => agent.id === "pi");
      expect(pi?.available).toBe(true);
      // Empty, not undefined: "no permission protocol" is an answer.
      expect(pi?.permissionModes).toEqual([]);
    } finally {
      await dispose();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
