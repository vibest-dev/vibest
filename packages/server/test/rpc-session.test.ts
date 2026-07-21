import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createRouterClient } from "@orpc/server";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { layerPaths } from "../src/config/paths";
import { EventBusLayer } from "../src/events";
import { FileSystemServiceLayer } from "../src/fs";
import {
  HarnessAgentRegistry,
  HarnessAgentSessionServiceLayer,
  makeHarnessAgentRegistry,
} from "../src/harness";
import { makeCodexAdapter, makeCodexAgent } from "../src/harness/codex";
import { ProjectRepositoryLayer, ProjectServiceLayer } from "../src/project";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";
import { Codex } from "../src/rpc/runtime";
import {
  HarnessAgentSessionPortLayer,
  SessionManagerLayer,
  SessionRepositoryLayer,
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
  if (msg.method === "thread/read") send({ id: msg.id, result: { thread: { id: "th_1", name: "Fake thread", preview: "hi", updatedAt: 1700000000 } } });
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

function setup() {
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
  const metadataLayer = SessionRepositoryLayer.pipe(Layer.provide(pathsLayer));
  const portLayer = HarnessAgentSessionPortLayer.pipe(Layer.provide(harnessSessionLayer));
  const managerLayer = SessionManagerLayer.pipe(Layer.provide(EventBusLayer));
  const sessionServiceLayer = SessionServiceLayer.pipe(
    Layer.provide(projectServiceLayer),
    Layer.provide(metadataLayer),
    Layer.provide(portLayer),
    Layer.provide(managerLayer),
    Layer.provide(EventBusLayer),
  );

  const appLayer = Layer.mergeAll(
    EventBusLayer,
    sessionServiceLayer,
    projectServiceLayer,
    registryLayer,
    FileSystemServiceLayer,
    NodeServices.layer,
  );
  const runtime = ManagedRuntime.make(appLayer);
  const context: RpcContext = {
    "effect/context": runtime.runSync(runtime.contextEffect),
  };
  const client = createRouterClient(router, { context });
  return { client, workspace, dispose: () => runtime.dispose() };
}

describe("session router", () => {
  it("creates a session from a project and streams its scoped events", async () => {
    const { client, workspace, dispose } = setup();
    try {
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
      await dispose();
    }
  });

  it("lists sessions with live status and drops them on delete", async () => {
    const { client, workspace, dispose } = setup();
    try {
      const project = await client.project.create({ path: workspace });
      const ref = await client.session.create({ projectId: project.id, harnessAgentId: "codex" });

      // Active session: list carries the live phase from the running runtime.
      const active = await client.session.list({ projectId: project.id });
      expect(active).toHaveLength(1);
      expect(active[0]?.sessionId).toBe(ref.sessionId);
      expect(active[0]?.status?.phase).toBeDefined();

      // Closed but not deleted: metadata stays, the runtime is gone → no status.
      await client.session.close({ ref });
      const idle = await client.session.list({ projectId: project.id });
      expect(idle).toHaveLength(1);
      expect(idle[0]?.status).toBeUndefined();

      // Delete: metadata removed → the session leaves the listing entirely.
      await client.session.delete({ ref });
      const empty = await client.session.list({ projectId: project.id });
      expect(empty).toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});
