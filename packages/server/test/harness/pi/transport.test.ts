import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { makePiTransport } from "../../../src/harness/pi/transport";

const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
// pi's CLI front-end may print human text and display hints before the loop:
process.stdout.write("pi 0.0.0 starting up (not json)\\n");
send({ type: "extension_ui_request", id: "st", method: "setStatus", statusKey: "k", statusText: "v" });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "extension_ui_response") {
    send({ type: "session_info_changed", name: "echo:" + JSON.stringify(msg) });
    return;
  }
  if (msg.type === "get_state") send({ id: msg.id, type: "response", command: "get_state", success: true, data: { sessionId: "s1" } });
  if (msg.type === "compact") send({ id: msg.id, type: "response", command: "compact", success: false, error: "nothing to compact" });
  if (msg.type === "steer") {
    send({ id: msg.id, type: "response", command: "steer", success: true });
    send({ type: "agent_start" });
    send({ type: "extension_ui_request", id: "c1", method: "confirm", title: "T", message: "M" });
  }
  if (msg.type === "bash") {
    process.stderr.write("x".repeat(1024 * 1024), () => send({ id: msg.id, type: "response", command: "bash", success: true, data: "drained" }));
  }
  if (msg.type === "abort") {
    process.stderr.write("pi fatal detail\\n", () => process.exit(7));
  }
});
`;

function makeFake(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-transport-"));
  const file = path.join(dir, "fake-pi.js");
  fs.writeFileSync(file, FAKE);
  fs.chmodSync(file, 0o755);
  return file;
}

layer(NodeServices.layer)("PiTransport", (it) => {
  it.effect("correlates command responses and exposes typed RPC errors", () =>
    Effect.gen(function* () {
      const transport = yield* makePiTransport({ executablePath: makeFake() });

      assert.deepEqual(yield* transport.command({ type: "get_state" }), {
        sessionId: "s1",
      });

      const error = yield* transport.command({ type: "compact" }).pipe(Effect.flip);
      assert.equal(error._tag, "PiRpcError");
      if (error._tag === "PiRpcError") {
        assert.equal(error.command, "compact");
        assert.equal(error.errorMessage, "nothing to compact");
      }
    }),
  );

  it.effect("skips CLI banner lines and fire-and-forget UI hints", () =>
    Effect.gen(function* () {
      const transport = yield* makePiTransport({ executablePath: makeFake() });
      // The banner and setStatus arrive before this response; neither must
      // fail the frame reader nor surface as an event or a blocking request.
      assert.deepEqual(yield* transport.command({ type: "get_state" }), {
        sessionId: "s1",
      });
    }),
  );

  it.effect("routes events and blocking UI requests as streams, and replies over stdin", () =>
    Effect.gen(function* () {
      const transport = yield* makePiTransport({ executablePath: makeFake() });
      const eventFiber = yield* Stream.runHead(transport.events).pipe(Effect.forkChild);
      const requestFiber = yield* Stream.runHead(transport.uiRequests).pipe(Effect.forkChild);

      yield* transport.command({ type: "steer", message: "go" });

      const event = yield* Fiber.join(eventFiber);
      const request = yield* Fiber.join(requestFiber);
      assert.equal(event._tag, "Some");
      if (event._tag === "Some") assert.equal(event.value.type, "agent_start");
      assert.equal(request._tag, "Some");
      if (request._tag === "Some") {
        assert.equal(request.value.method, "confirm");
        assert.equal(request.value.id, "c1");
      }

      const echoFiber = yield* Stream.runHead(transport.events).pipe(Effect.forkChild);
      yield* transport.respondUi({ type: "extension_ui_response", id: "c1", confirmed: true });
      const echo = yield* Fiber.join(echoFiber);
      assert.equal(echo._tag, "Some");
      if (echo._tag === "Some") {
        assert.match((echo.value as { name?: string }).name ?? "", /"confirmed":true/);
      }
    }),
  );

  it.effect("drains child stderr without blocking protocol responses", () =>
    Effect.gen(function* () {
      const transport = yield* makePiTransport({ executablePath: makeFake() });
      assert.equal(yield* transport.command({ type: "bash", command: "x" }), "drained");
    }),
  );

  it.effect("settles pending commands with a stderr tail when the process exits", () =>
    Effect.gen(function* () {
      const transport = yield* makePiTransport({ executablePath: makeFake() });
      const error = yield* transport.command({ type: "abort" }).pipe(Effect.flip);

      assert.equal(error._tag, "AgentProcessExited");
      if (error._tag === "AgentProcessExited") {
        assert.equal(error.code, 7);
        assert.match(error.stderrTail ?? "", /pi fatal detail/);
      }
    }),
  );

  it.effect("passes --session-id through to the child", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-args-"));
      const file = path.join(dir, "fake-pi.js");
      fs.writeFileSync(
        file,
        `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const index = process.argv.indexOf("--session-id");
  process.stdout.write(JSON.stringify({ id: msg.id, type: "response", command: "get_state", success: true, data: { sessionId: process.argv[index + 1] } }) + "\\n");
});
`,
      );
      fs.chmodSync(file, 0o755);
      const transport = yield* makePiTransport({ executablePath: file, sessionId: "sid-42" });
      assert.deepEqual(yield* transport.command({ type: "get_state" }), {
        sessionId: "sid-42",
      });
    }),
  );
});
