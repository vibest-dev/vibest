import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createRouterClient } from "@orpc/server";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { layerPaths } from "../src/config/paths";
import { EventBusLayer } from "../src/events";
import { FileSystemServiceLayer } from "../src/fs";
import {
  HarnessAgentRegistry,
  HarnessAgentSessionManagerLayer,
  HarnessAgentSessionServiceLayer,
  HarnessListLayer,
  HarnessProbeLayer,
  makeHarnessAgentRegistry,
} from "../src/harness";
import { makeCodexAdapter, makeCodexAgent } from "../src/harness/codex";
import { ProjectRepositoryLayer, ProjectServiceLayer } from "../src/project";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";
import { Codex } from "../src/rpc/runtime";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const file = path.join(dir, "fake-codex.js");
  fs.writeFileSync(file, FAKE);
  fs.chmodSync(file, 0o755);
  return file;
}

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-ws-"));
  // Paths plus the platform services the repositories' JSON store runs on.
  const pathsLayer = Layer.provideMerge(layerPaths(home), NodeServices.layer);

  // The fake path goes to the adapter too: `session.create` gates on
  // checkAvailability, which is a PATH lookup — without the override the test
  // silently depends on a real codex install.
  const executablePath = makeFake();
  const codexLayer = Layer.effect(Codex, makeCodexAgent({ executablePath })).pipe(
    Layer.provide(NodeServices.layer),
  );
  const registryLayer = Layer.effect(
    HarnessAgentRegistry,
    Effect.gen(function* () {
      const codex = yield* Codex;
      return makeHarnessAgentRegistry([makeCodexAdapter(codex, { executablePath })]);
    }),
  ).pipe(Layer.provide(codexLayer));

  // EventBusLayer is one reference so publish (manager/service) and subscribe
  // (RPC) share the single bus instance.
  const harnessSessionLayer = HarnessAgentSessionServiceLayer.pipe(
    Layer.provide(
      HarnessAgentSessionManagerLayer.pipe(
        Layer.provide(registryLayer),
        Layer.provide(EventBusLayer),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(registryLayer),
    Layer.provide(EventBusLayer),
    Layer.provide(pathsLayer),
    Layer.provide(NodeServices.layer),
  );
  const projectServiceLayer = ProjectServiceLayer.pipe(
    Layer.provide(ProjectRepositoryLayer),
    Layer.provide(pathsLayer),
  );

  const appLayer = Layer.mergeAll(
    EventBusLayer,
    harnessSessionLayer,
    projectServiceLayer,
    registryLayer,
    HarnessListLayer.pipe(Layer.provide(registryLayer), Layer.provide(NodeServices.layer)),
    HarnessProbeLayer.pipe(Layer.provide(registryLayer)),
    FileSystemServiceLayer.pipe(Layer.provide(NodeServices.layer)),
    NodeServices.layer,
  );
  const runtime = ManagedRuntime.make(appLayer);
  // Layer construction does file I/O now (the project document loads eagerly),
  // so the context must be built asynchronously.
  const context: RpcContext = {
    "effect/context": await runtime.runPromise(runtime.contextEffect),
  };
  const client = createRouterClient(router, { context });
  return { client, workspace, dispose: () => runtime.dispose() };
}

describe("session router", () => {
  it("creates a session from a project and streams its scoped events", async () => {
    const { client, workspace, dispose } = await setup();
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

  it("answers for a closed session over the wire instead of SESSION_NOT_ACTIVE", async () => {
    const { client, workspace, dispose } = await setup();
    try {
      const project = await client.project.create({ path: workspace });
      const ref = await client.session.create({ projectId: project.id, harnessAgentId: "codex" });
      await client.session.close({ ref });

      // What a browser does when it reopens the page after a server restart.
      // None of it used to be answerable without a live runtime, so the client
      // retried forever.
      const prepared = await client.session.prepare({ ref });
      const status = await client.session.getStatus({ ref });
      const snapshot = await client.session.getSnapshot({ ref });

      expect(prepared).toEqual(ref);
      expect(status).toEqual({ phase: "idle" });
      expect(snapshot.cursor).toBe(0);
      expect(snapshot.activeTurn).toBeNull();
    } finally {
      await dispose();
    }
  });

  it("lists sessions with live status and drops them on delete", async () => {
    const { client, workspace, dispose } = await setup();
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
