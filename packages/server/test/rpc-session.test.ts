import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createRouterClient } from "@orpc/server";
import { makeCodexAdapter, makeCodexAgent } from "@vibest/harness/codex";
import {
  HarnessAgentRegistry,
  HarnessAgentSessionServiceLayer,
  makeHarnessAgentRegistry,
} from "@vibest/harness/runtime";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { layerPaths } from "../src/config/paths";
import { EventBusLayer } from "../src/events";
import { ProjectRepositoryLayer, ProjectServiceLayer } from "../src/project";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";
import { Codex } from "../src/rpc/runtime";
import {
  HarnessSessionsPortLayer,
  SessionMetadataRepositoryLayer,
  SessionRuntimeRegistryLayer,
  SessionServiceLayer,
} from "../src/session";

const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "th_1" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn_1" } } });
    send({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_1" } } });
    send({ method: "item/started", params: { threadId: "th_1", item: { type: "agentMessage", id: "i1", text: "" } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "th_1", itemId: "i1", delta: "pong" } });
    send({ method: "item/completed", params: { threadId: "th_1", item: { type: "agentMessage", id: "i1", text: "pong" } } });
    send({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "turn_1", status: "completed" } } });
  }
  if (msg.method === "turn/interrupt" || msg.method === "thread/unsubscribe") send({ id: msg.id, result: null });
});
`;

function makeFake(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const file = join(dir, "fake-codex.js");
  writeFileSync(file, FAKE);
  chmodSync(file, 0o755);
  return file;
}

describe("session router", () => {
  it("creates a session from a project and streams its scoped events", async () => {
    const home = mkdtempSync(join(tmpdir(), "vibest-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "vibest-ws-"));
    const pathsLayer = layerPaths(home);

    const codexLayer = Layer.effect(Codex, makeCodexAgent({ executablePath: makeFake() })).pipe(
      Layer.provide(NodeServices.layer),
    );
    const registryLayer = Layer.effect(
      HarnessAgentRegistry,
      Effect.gen(function* () {
        const codex = yield* Codex;
        return makeHarnessAgentRegistry([makeCodexAdapter(codex)]);
      }),
    ).pipe(Layer.provide(codexLayer));

    const harnessSessionLayer = HarnessAgentSessionServiceLayer.pipe(Layer.provide(registryLayer));
    const projectServiceLayer = ProjectServiceLayer.pipe(
      Layer.provide(ProjectRepositoryLayer),
      Layer.provide(pathsLayer),
    );
    const metadataLayer = SessionMetadataRepositoryLayer.pipe(Layer.provide(pathsLayer));
    const portLayer = HarnessSessionsPortLayer.pipe(Layer.provide(harnessSessionLayer));
    const sessionServiceLayer = SessionServiceLayer.pipe(
      Layer.provide(projectServiceLayer),
      Layer.provide(metadataLayer),
      Layer.provide(portLayer),
    );
    const registryRuntimeLayer = SessionRuntimeRegistryLayer.pipe(Layer.provide(EventBusLayer));

    const appLayer = Layer.mergeAll(
      EventBusLayer,
      harnessSessionLayer,
      sessionServiceLayer,
      projectServiceLayer,
      registryRuntimeLayer,
    );
    const runtime = ManagedRuntime.make(appLayer);
    try {
      const context: RpcContext = {
        "effect/context": runtime.runSync(runtime.contextEffect),
      };
      const client = createRouterClient(router, { context });

      const project = await client.project.create({ path: workspace });
      const ref = await client.session.create({
        projectId: project.id,
        harnessAgentId: "codex",
      });
      expect(ref.projectId).toBe(project.id);
      expect(ref.harnessAgentId).toBe("codex");

      const events = await client.session.subscribe({ scope: { kind: "session", ref } });
      const receipt = await client.session.prompt({
        ref,
        parts: [{ type: "text", text: "ping" }],
      });
      expect(receipt).toMatchObject({ turnId: "turn_1" });

      const chunks: { type: string }[] = [];
      for await (const item of events) {
        if (item.type !== "event") continue;
        const event = item.event;
        if (event.type === "session.message.chunk") chunks.push(event.chunk);
        if (event.type === "session.turn.ended" && event.turnId === receipt.turnId) break;
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.at(-1)?.type).toBe("finish");

      const snapshot = await client.session.getSnapshot({ ref });
      expect(snapshot.cursor).toBeGreaterThan(0);
      await client.session.close({ ref });
    } finally {
      await runtime.dispose();
    }
  });
});
