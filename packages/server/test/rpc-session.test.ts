import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createRouterClient } from "@orpc/server";
import { isSessionEvent } from "@vibest/contract";
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
import { ProjectModuleLayer } from "../src/project";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";
import { Codex } from "../src/rpc/runtime";
import { SessionRepositoryLayer } from "../src/session";

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
  it("creates a provider session and streams its unified events", async () => {
    const testCodexLayer = Layer.effect(Codex, makeCodexAgent({ executablePath: makeFake() })).pipe(
      Layer.provide(NodeServices.layer),
    );
    const registryLayer = Layer.effect(
      HarnessAgentRegistry,
      Effect.gen(function* () {
        const codex = yield* Codex;
        return makeHarnessAgentRegistry([makeCodexAdapter(codex)]);
      }),
    ).pipe(Layer.provide(testCodexLayer));
    const sessionLayer = HarnessAgentSessionServiceLayer.pipe(
      Layer.provide(registryLayer),
      Layer.provide(EventBusLayer),
    );
    // create now persists a session record (and resume can recover the backend
    // id from it), so the router needs ProjectService + SessionRepository too.
    const pathsLayer = layerPaths(mkdtempSync(join(tmpdir(), "vibest-home-")));
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        EventBusLayer,
        sessionLayer,
        ProjectModuleLayer.pipe(Layer.provide(pathsLayer)),
        SessionRepositoryLayer.pipe(Layer.provide(pathsLayer)),
      ),
    );
    try {
      const context: RpcContext = {
        "effect/context": runtime.runSync(runtime.contextEffect),
      };
      const client = createRouterClient(router, { context });

      const { sessionId, harnessSessionId } = await client.session.create({
        harnessAgentId: "codex",
        workspacePath: "/tmp",
      });
      // sessionId is now a vibest-internal id; the backend threadId surfaces as
      // harnessSessionId.
      expect(harnessSessionId).toBe("th_1");
      expect(sessionId).toBeTruthy();
      expect(sessionId).not.toBe("th_1");

      const events = await client.session.events({ sessionId });
      const receipt = await client.session.prompt({
        sessionId,
        input: { parts: [{ type: "text", text: "ping" }] },
      });
      expect(receipt).toMatchObject({ turnId: "turn_1", started: true });

      const chunks: { type: string }[] = [];
      for await (const item of events) {
        if (item.type !== "event") continue;
        if (!isSessionEvent(item.event.body)) chunks.push(item.event.body);
        if (
          isSessionEvent(item.event.body) &&
          item.event.body.type === "session.turn.ended" &&
          item.event.body.turnId === receipt.turnId
        ) {
          break;
        }
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.at(-1)?.type).toBe("finish");

      const snapshot = await client.session.snapshot({ sessionId });
      expect(snapshot.cursor).toBeGreaterThan(0);
      await client.session.close({ sessionId });
    } finally {
      await runtime.dispose();
    }
  });
});
