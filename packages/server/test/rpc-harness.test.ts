import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PermissionMode } from "@vibest/contract";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { HarnessAgentAdapter } from "../src/harness";
import { makeRpcTestHarness } from "./rpc-harness";

// A list-only adapter: permission subset/availability/descriptor are declared,
// and open/resume die because listing never opens a session.
const fakeAdapter = (over: {
  id: HarnessAgentAdapter["id"];
  name: string;
  available: boolean;
  reason?: string;
  permissionModes?: ReadonlyArray<PermissionMode>;
}): HarnessAgentAdapter => ({
  id: over.id,
  descriptor: { id: over.id, name: over.name },
  checkAvailability: Effect.succeed(
    over.reason
      ? { available: over.available, reason: over.reason }
      : { available: over.available },
  ),
  permissionModes: over.permissionModes ?? [],
  open: () => Effect.die("list must not open a session"),
  resume: () => Effect.die("list must not resume a session"),
  getSessionInfo: () => Effect.succeed({ _tag: "unsupported" as const }),
});

describe("harness router", () => {
  it("lists every harness's availability and permission subset in one call", async () => {
    const adapters: ReadonlyArray<HarnessAgentAdapter> = [
      fakeAdapter({
        id: "claude-code",
        name: "Claude Code",
        available: true,
        permissionModes: ["plan", "ask", "acceptEdits", "full"],
      }),
      fakeAdapter({
        id: "codex",
        name: "Codex",
        available: false,
        reason: "codex CLI not found",
        permissionModes: ["read-only", "ask", "full"],
      }),
      fakeAdapter({ id: "pi", name: "Pi", available: true }),
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
      expect(codex).toMatchObject({
        available: false,
        reason: "codex CLI not found",
      });

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
