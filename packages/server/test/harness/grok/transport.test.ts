import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { makeGrokTransport } from "../../../src/harness/grok/transport";

const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
process.stdout.write("grok startup banner (not json)\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "echo") {
    process.stdout.write(JSON.stringify({ not: "rpc" }) + "\\n");
    send({ jsonrpc: "2.0", id: msg.id, result: msg.params });
  }
  if (msg.method === "boom") send({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "kaboom" } });
  if (msg.method === "stderrFlood") {
    process.stderr.write("x".repeat(1024 * 1024), () => send({ jsonrpc: "2.0", id: msg.id, result: "drained" }));
  }
  if (msg.method === "notifyMe") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
  }
  if (msg.method === "askMe") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    send({ jsonrpc: "2.0", method: "session/request_permission", id: 999, params: { sessionId: "s1" } });
  }
  if (msg.method === "exit") {
    process.stderr.write("fatal grok detail\\n", () => process.exit(7));
  }
});
`;

function makeFake(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-grok-transport-"));
  const file = path.join(dir, "fake-grok.js");
  fs.writeFileSync(file, FAKE);
  fs.chmodSync(file, 0o755);
  return file;
}

layer(NodeServices.layer)("GrokTransport", (it) => {
  it.effect("correlates responses and exposes typed RPC errors", () =>
    Effect.gen(function* () {
      const transport = yield* makeGrokTransport({ executablePath: makeFake() });

      assert.deepEqual(yield* transport.request("echo", { answer: 42 }), {
        answer: 42,
      });

      const error = yield* transport.request("boom").pipe(Effect.flip);
      assert.equal(error._tag, "GrokRpcError");
      if (error._tag === "GrokRpcError") assert.equal(error.code, -1);
    }),
  );

  it.effect("skips CLI banner lines", () =>
    Effect.gen(function* () {
      const transport = yield* makeGrokTransport({ executablePath: makeFake() });
      assert.deepEqual(yield* transport.request("echo", { ok: true }), { ok: true });
    }),
  );

  it.effect("drains child stderr without blocking protocol responses", () =>
    Effect.gen(function* () {
      const transport = yield* makeGrokTransport({ executablePath: makeFake() });
      assert.equal(yield* transport.request("stderrFlood"), "drained");
    }),
  );

  it.effect("routes notifications and server requests as streams", () =>
    Effect.gen(function* () {
      const transport = yield* makeGrokTransport({ executablePath: makeFake() });
      const notificationFiber = yield* Stream.runHead(transport.notifications).pipe(
        Effect.forkChild,
      );
      const requestFiber = yield* Stream.runHead(transport.serverRequests).pipe(Effect.forkChild);

      yield* transport.request("notifyMe");
      yield* transport.request("askMe");

      const notification = yield* Fiber.join(notificationFiber);
      const request = yield* Fiber.join(requestFiber);
      assert.equal(notification._tag, "Some");
      assert.equal(request._tag, "Some");
      if (notification._tag === "Some") {
        assert.equal(notification.value.method, "session/update");
      }
      if (request._tag === "Some") assert.equal(request.value.id, 999);
    }),
  );

  it.effect("fails pending requests when the child exits", () =>
    Effect.gen(function* () {
      const transport = yield* makeGrokTransport({ executablePath: makeFake() });
      const pending = yield* transport.request("exit").pipe(Effect.flip);
      assert.equal(pending._tag, "AgentProcessExited");
      if (pending._tag === "AgentProcessExited") {
        assert.equal(pending.harnessAgentId, "grok");
        assert.equal(pending.code, 7);
      }
    }),
  );
});
