import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PermissionMode } from "@vibest/contract";
import { Effect, Stream } from "effect";
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
  listModelProviders?: HarnessAgentAdapter["listModelProviders"];
  getDefaultModel?: HarnessAgentAdapter["getDefaultModel"];
}): HarnessAgentAdapter => ({
  id: over.id,
  descriptor: { id: over.id, name: over.name },
  checkAvailability: Effect.succeed(
    over.reason
      ? { available: over.available, reason: over.reason }
      : { available: over.available },
  ),
  permissionModes: over.permissionModes ?? [],
  ...(over.listModelProviders ? { listModelProviders: over.listModelProviders } : {}),
  getDefaultModel: over.getDefaultModel ?? (() => Effect.succeed({})),
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

  it("resolves a fresh session's default model separately from the catalog", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-rpc-harness-default-model-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-rpc-harness-workspace-"));
    const { client, dispose } = await makeRpcTestHarness(home, [
      fakeAdapter({
        id: "pi",
        name: "Pi",
        available: true,
        getDefaultModel: () =>
          Effect.succeed({ providerId: "anthropic", modelId: "claude-sonnet" }),
      }),
    ]);
    try {
      await expect(
        client.harness.getDefaultModel({ harnessAgentId: "pi", cwd: workspace }),
      ).resolves.toEqual({ providerId: "anthropic", modelId: "claude-sonnet" });
    } finally {
      await dispose();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes a managed sessionId through the shared live runtime", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-rpc-harness-live-models-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-rpc-harness-workspace-"));
    const selected: Array<[string, string]> = [];
    const adapter: HarnessAgentAdapter = {
      ...fakeAdapter({
        id: "pi",
        name: "Pi",
        available: true,
        listModelProviders: () =>
          Effect.succeed([{ id: "directory", models: [{ id: "temporary" }] }]),
      }),
      acceptsModelProvider: () => true,
      open: () =>
        Effect.succeed({
          sessionId: "native-pi",
          harnessAgentId: "pi",
          events: Stream.never,
          prompt: () => Effect.succeed({ turnId: "turn-1" }),
          getModel: Effect.succeed({}),
          setModel: (providerId, modelId) =>
            Effect.sync(() => selected.push([providerId, modelId])).pipe(Effect.asVoid),
          setReasoningEffort: () => Effect.void,
          setPermissionMode: () => Effect.void,
          interrupt: Effect.void,
          respondToAgentRequest: () => Effect.void,
          getCapabilities: Effect.succeed({
            supportsResume: true,
            supportsSteering: true,
            supportsPermissions: false,
          }),
          listModelProviders: Effect.succeed([{ id: "live", models: [{ id: "current-session" }] }]),
          close: Effect.void,
        }),
    };
    const { client, dispose } = await makeRpcTestHarness(home, [adapter]);
    try {
      const project = await client.project.create({ path: workspace });
      const ref = await client.session.create({
        projectId: project.id,
        harnessAgentId: "pi",
        providerId: "anthropic",
        modelId: "claude-sonnet",
      });
      expect(selected).toEqual([["anthropic", "claude-sonnet"]]);
      const result = await client.harness.listModels({
        harnessAgentId: "pi",
        cwd: workspace,
        ref,
        runtimeActive: false,
      });

      expect(result.providers).toEqual([{ id: "live", models: [{ id: "current-session" }] }]);
    } finally {
      await dispose();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("lists model providers without opening a managed session", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-rpc-harness-models-"));
    const { client, dispose } = await makeRpcTestHarness(home, [
      fakeAdapter({
        id: "pi",
        name: "Pi",
        available: true,
        listModelProviders: (cwd) =>
          Effect.succeed([
            {
              id: "anthropic",
              models: [{ id: "claude-sonnet", label: cwd }],
            },
          ]),
      }),
    ]);
    try {
      const result = await client.harness.listModels({
        harnessAgentId: "pi",
        cwd: "/work/app",
      });

      expect(result.providers).toEqual([
        {
          id: "anthropic",
          models: [{ id: "claude-sonnet", label: "/work/app" }],
        },
      ]);
    } finally {
      await dispose();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
