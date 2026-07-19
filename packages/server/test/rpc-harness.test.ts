import { createRouterClient } from "@orpc/server";
import {
  HarnessAgentRegistryLayer,
  HarnessAgentSessionServiceLayer,
  type HarnessAgentAdapter,
} from "@vibest/harness/runtime";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { EventBusLayer } from "../src/events";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";

// A negotiation-only adapter: capabilities/availability/descriptor are declared,
// and open/resume die because negotiate never opens a session.
const fakeAdapter = (over: {
  id: HarnessAgentAdapter["id"];
  name: string;
  available: boolean;
  reason?: string;
  permissionModes?: ReadonlyArray<{ id: string; label: string }>;
}): HarnessAgentAdapter => ({
  id: over.id,
  descriptor: { id: over.id, name: over.name },
  checkAvailability: Effect.succeed(
    over.reason
      ? { available: over.available, reason: over.reason }
      : { available: over.available },
  ),
  capabilities: Effect.succeed(
    over.permissionModes ? { permissionModes: over.permissionModes } : {},
  ),
  open: () => Effect.die("negotiate must not open a session"),
  resume: () => Effect.die("negotiate must not resume a session"),
});

describe("harness router", () => {
  it("negotiates every harness's availability and capabilities in one call", async () => {
    const registryLayer = HarnessAgentRegistryLayer([
      fakeAdapter({
        id: "claude-code",
        name: "Claude Code",
        available: true,
        permissionModes: [
          { id: "plan", label: "Plan" },
          { id: "ask", label: "Ask" },
          { id: "acceptEdits", label: "Accept edits" },
          { id: "full", label: "Full access" },
        ],
      }),
      fakeAdapter({
        id: "codex",
        name: "Codex",
        available: false,
        reason: "codex CLI not found",
        permissionModes: [
          { id: "read-only", label: "Read only" },
          { id: "ask", label: "Ask" },
          { id: "full", label: "Full access" },
        ],
      }),
      fakeAdapter({ id: "pi", name: "Pi", available: true }),
    ]);
    const sessionLayer = HarnessAgentSessionServiceLayer.pipe(
      Layer.provide(registryLayer),
      Layer.provide(EventBusLayer),
    );
    const runtime = ManagedRuntime.make(Layer.mergeAll(EventBusLayer, sessionLayer, registryLayer));
    try {
      const context: RpcContext = { "effect/context": runtime.runSync(runtime.contextEffect) };
      const client = createRouterClient(router, { context });

      const { harnessAgents } = await client.harness.negotiate({});

      expect(harnessAgents.map((agent) => agent.id)).toEqual(["claude-code", "codex", "pi"]);

      const claude = harnessAgents.find((agent) => agent.id === "claude-code");
      expect(claude).toMatchObject({ name: "Claude Code", available: true });
      expect(claude?.reason).toBeUndefined();
      expect(claude?.capabilities.permissionModes?.map((mode) => mode.id)).toEqual([
        "plan",
        "ask",
        "acceptEdits",
        "full",
      ]);

      const codex = harnessAgents.find((agent) => agent.id === "codex");
      expect(codex).toMatchObject({ available: false, reason: "codex CLI not found" });

      const pi = harnessAgents.find((agent) => agent.id === "pi");
      expect(pi?.available).toBe(true);
      expect(pi?.capabilities.permissionModes).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});
