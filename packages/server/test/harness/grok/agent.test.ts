import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { makeGrokAdapter } from "../../../src/harness/grok/adapter";
import { makeGrokAgent } from "../../../src/harness/grok/agent";

const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let pendingPrompt = null;
const completePrompt = (sessionId) => {
  if (pendingPrompt === null) return;
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "_x.ai/session_notification",
    params: { sessionId, update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" } },
  });
  send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "end_turn" } });
  pendingPrompt = null;
};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (message) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } });
  if (msg.method === "initialize") {
    reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    return;
  }
  if (msg.method === "_x.ai/models/list") {
    reply({
      currentModelId: "grok-4.6",
      availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }],
    });
    return;
  }
  if (msg.method === "session/new") {
    reply({ sessionId: "sess-new" });
    return;
  }
  if (msg.method === "session/load") {
    if (msg.params.sessionId === "missing") return fail("session not found");
    reply({ sessionId: msg.params.sessionId });
    return;
  }
  if (msg.method === "session/set_model" || msg.method === "session/set_mode" || msg.method === "session/close") {
    reply({});
    return;
  }
  if (msg.method === "session/prompt") {
    const text = msg.params.prompt[0].text;
    if (text === "ask") {
      pendingPrompt = msg.id;
      send({
        jsonrpc: "2.0",
        method: "session/request_permission",
        id: 900,
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: "c1", title: "run_terminal_command", rawInput: { command: "ls" } },
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" },
      },
    });
    reply({ stopReason: "end_turn" });
    return;
  }
  if (msg.id === 900) completePrompt("sess-new");
});
`;

function makeFake(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-grok-agent-"));
  const file = path.join(dir, "fake-grok.js");
  fs.writeFileSync(file, FAKE);
  fs.chmodSync(file, 0o755);
  return file;
}

layer(NodeServices.layer)("GrokAgent", (it) => {
  it.effect("creates a session and streams a full turn", () =>
    Effect.gen(function* () {
      const agent = yield* makeGrokAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      assert.equal(sessionId, "sess-new");

      const prompt = yield* agent.session.prompt({ sessionId, text: "ping" });
      assert.equal(prompt.started, true);
      const chunks = yield* Stream.runCollect(prompt.output);
      assert.deepEqual(
        Array.from(chunks, (chunk) => chunk.type),
        ["start", "text-start", "text-delta", "text-end", "finish"],
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("resume keeps the caller-provided session id", () =>
    Effect.gen(function* () {
      const agent = yield* makeGrokAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.resume({
        sessionId: "custom-id",
        cwd: "/tmp",
      });
      assert.equal(sessionId, "custom-id");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("fails to resume a missing session", () =>
    Effect.gen(function* () {
      const agent = yield* makeGrokAgent({ executablePath: makeFake() });
      const error = yield* agent.session
        .resume({ sessionId: "missing", cwd: "/tmp" })
        .pipe(Effect.flip);
      assert.equal(error._tag, "SessionNotResumable");
    }),
  );

  it.effect("round-trips a permission request", () =>
    Effect.gen(function* () {
      const agent = yield* makeGrokAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const requestFiber = yield* Stream.runHead(agent.session.requestPermission(sessionId)).pipe(
        Effect.forkChild,
      );
      const prompt = yield* agent.session.prompt({ sessionId, text: "ask" });
      const collected = yield* Effect.forkChild(Stream.runCollect(prompt.output));

      const request = yield* Fiber.join(requestFiber);
      assert.equal(request._tag, "Some");
      if (request._tag !== "Some") return;
      assert.equal(request.value.type, "tool");
      yield* agent.session.respondPermission(sessionId, request.value.id, {
        type: "tool",
        behavior: "allow",
        selectedActionId: "allow-once",
      });
      yield* Fiber.join(collected);
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("lists models without opening a session", () =>
    Effect.gen(function* () {
      const agent = yield* makeGrokAgent({ executablePath: makeFake() });
      const models = yield* agent.listModels;
      assert.equal(models.currentModelId, "grok-4.6");
      assert.equal(models.availableModels?.[0]?.modelId, "grok-4.6");
    }),
  );

  it.effect("adapter open yields a grok runtime", () =>
    Effect.gen(function* () {
      const agent = yield* makeGrokAgent({ executablePath: makeFake() });
      const session = yield* makeGrokAdapter(agent).open({ cwd: "/tmp" });
      assert.equal(session.harnessAgentId, "grok");
      yield* session.close;
    }),
  );
});
