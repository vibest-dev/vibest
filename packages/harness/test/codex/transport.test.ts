import * as NodeAssert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { makeCodexTransport } from "../../src/codex/runtime/transport";

const FAKE = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "echo") send({ id: msg.id, result: msg.params });
  if (msg.method === "boom") send({ id: msg.id, error: { code: -1, message: "kaboom" } });
  if (msg.method === "stderrFlood") {
    process.stderr.write("x".repeat(1024 * 1024), () => send({ id: msg.id, result: "drained" }));
  }
  if (msg.method === "notifyMe") {
    send({ id: msg.id, result: null });
    send({ method: "turn/started", params: { threadId: "th", turn: { id: "t1" } } });
  }
  if (msg.method === "askMe") {
    send({ id: msg.id, result: null });
    send({ method: "item/commandExecution/requestApproval", id: 999, params: { threadId: "th" } });
  }
  if (msg.method === "invalid") process.stdout.write("not-json\\n");
  if (msg.method === "exit") {
    process.stderr.write("fatal codex detail\\n", () => process.exit(7));
  }
  if (msg.method === "exitWithInheritedStderr") {
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
      detached: true,
      stdio: ["ignore", "ignore", process.stderr],
    });
    grandchild.unref();
    process.exit(8);
  }
});
`;

function makeFake(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-effect-codex-"));
  const file = join(dir, "fake-codex.js");
  writeFileSync(file, FAKE);
  chmodSync(file, 0o755);
  return file;
}

layer(NodeServices.layer)("CodexTransport", (it) => {
  it.effect("correlates responses and exposes typed RPC errors", () =>
    Effect.gen(function* () {
      const transport = yield* makeCodexTransport({ executablePath: makeFake() });

      NodeAssert.deepStrictEqual(yield* transport.request("echo", { answer: 42 }), {
        answer: 42,
      });

      const error = yield* transport.request("boom").pipe(Effect.flip);
      NodeAssert.equal(error._tag, "CodexRpcError");
      if (error._tag === "CodexRpcError") NodeAssert.equal(error.code, -1);
    }),
  );

  it.effect("drains child stderr without blocking protocol responses", () =>
    Effect.gen(function* () {
      const transport = yield* makeCodexTransport({ executablePath: makeFake() });

      NodeAssert.equal(yield* transport.request("stderrFlood"), "drained");
    }),
  );

  it.effect("routes notifications and server requests as streams", () =>
    Effect.gen(function* () {
      const transport = yield* makeCodexTransport({ executablePath: makeFake() });
      const notificationFiber = yield* Stream.runHead(transport.notifications).pipe(
        Effect.forkChild,
      );
      const requestFiber = yield* Stream.runHead(transport.serverRequests).pipe(Effect.forkChild);

      yield* transport.request("notifyMe");
      yield* transport.request("askMe");

      const notification = yield* Fiber.join(notificationFiber);
      const request = yield* Fiber.join(requestFiber);
      NodeAssert.equal(notification._tag, "Some");
      NodeAssert.equal(request._tag, "Some");
      if (notification._tag === "Some") {
        NodeAssert.equal(notification.value.method, "turn/started");
      }
      if (request._tag === "Some") NodeAssert.equal(request.value.id, 999);
    }),
  );

  it.effect("fails pending requests on invalid protocol input", () =>
    Effect.gen(function* () {
      const transport = yield* makeCodexTransport({ executablePath: makeFake() });
      const error = yield* transport.request("invalid").pipe(Effect.flip);

      NodeAssert.equal(error._tag, "AgentProtocolError");
    }),
  );

  it.effect("settles every concurrent request when the process exits", () =>
    Effect.gen(function* () {
      const transport = yield* makeCodexTransport({ executablePath: makeFake() });
      const exits = yield* Effect.all(
        Array.from({ length: 128 }, () => transport.request("exit").pipe(Effect.exit)),
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("2 seconds"));

      NodeAssert.equal(exits.length, 128);
      for (const exit of exits) NodeAssert.equal(exit._tag, "Failure");
    }),
  );

  it.effect("does not wait indefinitely for inherited stderr handles", () =>
    Effect.gen(function* () {
      const transport = yield* makeCodexTransport({ executablePath: makeFake() });
      const error = yield* transport
        .request("exitWithInheritedStderr")
        .pipe(Effect.flip, Effect.timeout("750 millis"));

      NodeAssert.equal(error._tag, "AgentProcessExited");
      if (error._tag === "AgentProcessExited") NodeAssert.equal(error.code, 8);
    }),
  );

  it.effect("includes a bounded stderr tail when the process exits", () =>
    Effect.gen(function* () {
      const transport = yield* makeCodexTransport({ executablePath: makeFake() });
      const error = yield* transport.request("exit").pipe(Effect.flip);

      NodeAssert.equal(error._tag, "AgentProcessExited");
      if (error._tag === "AgentProcessExited") {
        NodeAssert.equal(error.code, 7);
        NodeAssert.match(error.stderrTail ?? "", /fatal codex detail/);
      }
    }),
  );
});
