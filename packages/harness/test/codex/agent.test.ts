import * as NodeAssert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { makeCodexAgent } from "../../src/codex/agent";
import { makeCodexAdapter } from "../../src/codex/runtime/adapter";

const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "th_1" } } });
  if (msg.method === "turn/start") {
    if (msg.params.input[0].text === "flood") {
      send({ id: msg.id, result: { turn: { id: "turn_flood" } } });
      send({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_flood" } } });
      for (let index = 0; index < 1100; index += 1) {
        send({ method: "item/agentMessage/delta", params: { threadId: "th_1", itemId: "i1", delta: "x" } });
      }
      send({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "turn_flood", status: "completed" } } });
      return;
    }
    if (msg.params.input[0].text === "retry") {
      send({ id: msg.id, result: { turn: { id: "turn_retry" } } });
      send({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_retry" } } });
      send({ method: "error", params: { threadId: "th_1", willRetry: true, error: { message: "retrying" } } });
      send({ method: "item/agentMessage/delta", params: { threadId: "th_1", itemId: "i1", delta: "recovered" } });
      send({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "turn_retry", status: "completed" } } });
      return;
    }
    if (msg.params.input[0].text === "crash") {
      send({ id: msg.id, result: { turn: { id: "turn_2" } } });
      send({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_2" } } });
      send({ method: "item/agentMessage/delta", params: { threadId: "th_1", itemId: "i1", delta: "po" } });
      process.stdout.write("", () => process.exit(1));
      return;
    }
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

layer(NodeServices.layer)("CodexAgent", (it) => {
  it.effect("creates a thread and streams a full turn", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
      NodeAssert.equal(sessionId, "th_1");

      const prompt = yield* agent.session.prompt({ sessionId, text: "ping" });
      const chunks = yield* Stream.runCollect(prompt.output);
      NodeAssert.deepStrictEqual(
        Array.from(chunks, (chunk) => chunk.type),
        ["start", "text-start", "text-delta", "text-end", "data-turn/completed", "finish"],
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("exposes prompt output through the unified adapter event stream", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const session = yield* makeCodexAdapter(agent).open({ workspacePath: "/tmp" });
      const collected = yield* Effect.forkChild(
        Stream.runCollect(
          session.events.pipe(
            Stream.takeUntil((event) => event.body.type === "session.turn.ended"),
          ),
        ),
      );

      const receipt = yield* session.prompt({ parts: [{ type: "text", text: "ping" }] });
      const events = yield* Fiber.join(collected);

      NodeAssert.equal(receipt.turnId, "turn_1");
      NodeAssert.equal(receipt.cursor, 0);
      NodeAssert.deepStrictEqual(
        Array.from(events, (event) => event.body.type),
        [
          "session.turn.started",
          "start",
          "text-start",
          "text-delta",
          "text-end",
          "data-turn/completed",
          "finish",
          "session.turn.ended",
        ],
      );
      yield* session.close;
    }),
  );

  it.effect("keeps a retryable error inside the active turn", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
      const prompt = yield* agent.session.prompt({ sessionId, text: "retry" });
      const chunks = yield* Stream.runCollect(prompt.output);

      NodeAssert.ok(Array.from(chunks).some((chunk) => chunk.type === "error"));
      NodeAssert.equal(chunks.at(-1)?.type, "finish");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("does not let an abandoned session stall the shared transport", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });

      const prompt = yield* agent.session.prompt({ sessionId, text: "flood" });
      yield* Stream.runHead(prompt.output);
      const replacement = yield* agent.session
        .create({ workspacePath: "/tmp" })
        .pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal(replacement.sessionId, "th_1");
      yield* agent.session.abort(replacement.sessionId);
    }),
  );

  it.effect("crashes existing sessions and lazily starts a replacement transport", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
      const prompt = yield* agent.session.prompt({ sessionId, text: "crash" });
      const chunks = yield* Stream.runCollect(prompt.output);
      NodeAssert.deepStrictEqual(
        Array.from(chunks, (chunk) => chunk.type),
        ["start", "text-start", "text-delta", "error"],
      );

      const replacement = yield* agent.session.create({ workspacePath: "/tmp" });
      const replacementPrompt = yield* agent.session.prompt({
        sessionId: replacement.sessionId,
        text: "ping",
      });
      const replacementChunks = yield* Stream.runCollect(replacementPrompt.output);
      NodeAssert.equal(replacementChunks.at(-1)?.type, "finish");
      yield* agent.session.abort(replacement.sessionId);
    }),
  );
});
