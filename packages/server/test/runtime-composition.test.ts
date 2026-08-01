import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { HarnessAgentRegistry, makeHarnessAgentRegistry } from "../src/harness";
import { makeFakeAdapter, makeFakeSession } from "./fake-adapter";
import { makeRpcTestHarness } from "./rpc-harness";

// The composition invariant under test: Effect memoizes layers by reference,
// so shared state (the event bus, the registry) exists once only because
// `makeAgentRuntimeLayer` threads the same Layer values through every
// consumer. These tests exercise that contract behaviourally — publish through
// one consumer, observe through another — so an inline reconstruction (or a
// `Layer.fresh`) of a stateful layer fails here instead of silently splitting
// state in production.

/** An always-available in-memory adapter that can open sessions. */
const openableAdapter = () => {
  let opens = 0;
  return makeFakeAdapter({
    id: "pi",
    name: "Pi (fake)",
    open: () =>
      Effect.sync(() => {
        opens += 1;
        return makeFakeSession({ sessionId: `native-${opens}`, harnessAgentId: "pi" });
      }),
  });
};

async function withTempDirs<A>(run: (home: string, workspace: string) => Promise<A>): Promise<A> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-runtime-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-runtime-ws-"));
  try {
    return await run(home, workspace);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

describe("agent runtime composition", () => {
  it("delivers a session-service publish to an RPC subscriber — one bus, not two", async () => {
    await withTempDirs(async (home, workspace) => {
      const { client, dispose } = await makeRpcTestHarness(home, [openableAdapter()]);
      try {
        // Subscribe through the RPC route first (the bus has no replay), then
        // publish by creating a session through the session service. The event
        // only arrives if both sides resolved the same bus instance.
        const events = await client.session.subscribe({ scope: { kind: "global" } });
        const firstCreated = (async () => {
          for await (const item of events) {
            if (item.type === "event" && item.event.type === "session.created") return item.event;
          }
          return null;
        })();

        const project = await client.project.create({ path: workspace });
        const ref = await client.session.create({ projectId: project.id, harnessAgentId: "pi" });

        let timer: ReturnType<typeof setTimeout> | undefined;
        const received = await Promise.race([
          firstCreated,
          new Promise<"split bus: publish never reached the subscriber">((resolve) => {
            timer = setTimeout(
              () => resolve("split bus: publish never reached the subscriber"),
              5_000,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        expect(received).toMatchObject({ type: "session.created", ref });
      } finally {
        await dispose();
      }
    });
  });

  it("serves list, probe, and session create from one registry instance", async () => {
    await withTempDirs(async (home, workspace) => {
      let registryBuilds = 0;
      const registry = Layer.sync(HarnessAgentRegistry, () => {
        registryBuilds += 1;
        return makeHarnessAgentRegistry([openableAdapter()]);
      });
      const { client, dispose } = await makeRpcTestHarness(home, registry);
      try {
        const { harnessAgents } = await client.harness.list({});
        expect(harnessAgents.map((agent) => agent.id)).toEqual(["pi"]);

        const probed = await client.harness.probe({ harnessAgentId: "pi", cwd: workspace });
        expect(probed.providers).toEqual([]);

        const project = await client.project.create({ path: workspace });
        const ref = await client.session.create({ projectId: project.id, harnessAgentId: "pi" });
        expect(ref.harnessAgentId).toBe("pi");

        // Every consumer resolved the layer built above; a reconstruction for
        // any one of them would have run the effect a second time.
        expect(registryBuilds).toBe(1);
      } finally {
        await dispose();
      }
    });
  });
});
