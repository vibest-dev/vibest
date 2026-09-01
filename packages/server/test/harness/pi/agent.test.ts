import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";

import { makePiAdapter } from "../../../src/harness/pi/adapter";
import { makePiAgent } from "../../../src/harness/pi/agent";

const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
const sidIndex = process.argv.indexOf("--session-id");
const sessionId = sidIndex === -1 ? "default-sid" : process.argv[sidIndex + 1];
process.stdout.write("pi startup banner (not json)\\n");
send({ type: "extension_ui_request", id: "st", method: "setStatus", statusKey: "k", statusText: "v" });
if (sessionId === "missing-session") {
  process.stdout.write("No session found matching 'missing-session'\\n", () => process.exit(0));
}
const assistant = (over = {}) => ({ role: "assistant", content: [], api: "a", provider: "p", model: "m1", usage: { input: 1, output: 2 }, stopReason: "stop", timestamp: 0, ...over });
const upd = (ev) => send({ type: "message_update", message: assistant(), assistantMessageEvent: ev });
const settle = (last) => { send({ type: "agent_end", messages: [last || assistant()], willRetry: false }); send({ type: "agent_settled" }); };
let holding = false;
let heldSteer = null;
const completeHeldSteer = () => {
  if (!heldSteer) return;
  const msg = heldSteer;
  heldSteer = null;
  send({ id: msg.id, type: "response", command: "steer", success: true });
};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "get_state") { send({ id: msg.id, type: "response", command: "get_state", success: true, data: { sessionId } }); return; }
  if (msg.type === "extension_ui_response") {
    upd({ type: "start" });
    upd({ type: "text_start", contentIndex: 0 });
    upd({ type: "text_delta", contentIndex: 0, delta: "confirmed:" + String(msg.confirmed) });
    upd({ type: "text_end", contentIndex: 0, content: "" });
    settle();
    return;
  }
  if (msg.type === "steer") {
    if (msg.message === "hold-steer") { heldSteer = msg; return; }
    send({ id: msg.id, type: "response", command: "steer", success: true });
    if (holding) { holding = false; settle(); }
    return;
  }
  if (msg.type === "abort") {
    send({ id: msg.id, type: "response", command: "abort", success: true });
    if (holding) { holding = false; settle(assistant({ stopReason: "aborted" })); }
    completeHeldSteer();
    return;
  }
  if (msg.type !== "prompt") return;
  const text = msg.message;
  if (text === "fail") { send({ id: msg.id, type: "response", command: "prompt", success: false, error: "cannot prompt" }); return; }
  if (text === "release-steer") completeHeldSteer();
  send({ id: msg.id, type: "response", command: "prompt", success: true });
  send({ type: "agent_start" });
  if (text === "hold") { holding = true; return; }
  if (text === "confirm") { send({ type: "extension_ui_request", id: "ui1", method: "confirm", title: "Run?", message: "Run the tool?" }); return; }
  if (text === "tool") {
    send({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    send({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
    settle();
    return;
  }
  if (text === "crash") {
    upd({ type: "start" });
    upd({ type: "text_start", contentIndex: 0 });
    upd({ type: "text_delta", contentIndex: 0, delta: "po" });
    process.stdout.write("", () => process.exit(1));
    return;
  }
  upd({ type: "start" });
  upd({ type: "text_start", contentIndex: 0 });
  upd({ type: "text_delta", contentIndex: 0, delta: "pong" });
  upd({ type: "text_end", contentIndex: 0, content: "pong" });
  send({ type: "message_end", message: assistant() });
  settle();
});
`;

function makeFake(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-"));
  const file = path.join(dir, "fake-pi.js");
  fs.writeFileSync(file, FAKE);
  fs.chmodSync(file, 0o755);
  return file;
}

layer(NodeServices.layer)("PiAgent", (it) => {
  it.effect("creates a session and streams a full turn", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);

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
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.resume({
        sessionId: "custom-id",
        cwd: "/tmp",
      });
      assert.equal(sessionId, "custom-id");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("fails to open when pi cannot resolve the session", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const error = yield* agent.session
        .resume({ sessionId: "missing-session", cwd: "/tmp" })
        .pipe(Effect.flip);
      assert.equal(error._tag, "AgentProcessExited");
    }),
  );

  it.effect("streams tool executions as typed tool chunks", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const prompt = yield* agent.session.prompt({ sessionId, text: "tool" });
      const chunks = yield* Stream.runCollect(prompt.output);
      assert.deepEqual(
        Array.from(chunks, (chunk) => chunk.type),
        ["start", "tool-input-available", "tool-output-available", "finish"],
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("round-trips a blocking extension UI request through respondPermission", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const requestFiber = yield* Stream.runHead(agent.session.requestPermission(sessionId)).pipe(
        Effect.forkChild,
      );
      const prompt = yield* agent.session.prompt({ sessionId, text: "confirm" });
      const collected = yield* Effect.forkChild(Stream.runCollect(prompt.output));

      const request = yield* Fiber.join(requestFiber);
      assert.equal(request._tag, "Some");
      if (request._tag !== "Some") return;
      assert.deepEqual(request.value, {
        harnessAgentId: "pi",
        type: "question",
        id: "ui1",
        questions: [
          {
            id: "ui1",
            question: "Run the tool?",
            header: "Run?",
            kind: "choice",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
        native: {
          type: "extension_ui_request",
          id: "ui1",
          method: "confirm",
          title: "Run?",
          message: "Run the tool?",
        },
      });

      const accepted = yield* agent.session.respondPermission(sessionId, "ui1", {
        type: "question",
        answers: [{ questionId: "ui1", values: ["Yes"] }],
      });
      assert.equal(accepted, true);

      const chunks = yield* Fiber.join(collected);
      const deltas = Array.from(chunks).filter((chunk) => chunk.type === "text-delta");
      assert.ok(
        deltas.some((chunk) => "delta" in chunk && chunk.delta === "confirmed:true"),
        "the confirm answer did not reach the pi child",
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("steers only the expected active turn", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const first = yield* agent.session.prompt({ sessionId, text: "hold" });
      assert.equal(first.started, true);

      yield* agent.session.steer({
        sessionId,
        expectedTurnId: first.turnId,
        text: "also do this",
      });
      const stale = yield* agent.session
        .steer({ sessionId, expectedTurnId: "other-turn", text: "wrong turn" })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "TurnAlreadyRunning");

      const chunks = yield* Stream.runCollect(first.output);
      assert.equal(Array.from(chunks).at(-1)?.type, "finish");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("keeps the checked turn reserved until the native steer is accepted", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const first = yield* agent.session.prompt({ sessionId, text: "hold" });
      const steer = yield* agent.session
        .steer({ sessionId, expectedTurnId: first.turnId, text: "hold-steer" })
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      const laterPrompt = yield* agent.session
        .prompt({ sessionId, text: "hold" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const firstOutput = yield* Stream.runCollect(first.output).pipe(Effect.forkChild);
      yield* agent.session.interrupt(sessionId);
      yield* Fiber.join(steer);
      yield* Fiber.join(firstOutput);

      const later = yield* Fiber.join(laterPrompt);
      assert.notEqual(later.turnId, first.turnId);
      const stale = yield* agent.session
        .steer({ sessionId, expectedTurnId: first.turnId, text: "wrong turn" })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "TurnAlreadyRunning");
      assert.equal(stale.turnId, later.turnId);

      yield* agent.session.interrupt(sessionId);
      yield* Stream.runCollect(later.output);
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("rejects a generic prompt while a turn is active", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const first = yield* agent.session.prompt({ sessionId, text: "hold" });

      const second = yield* agent.session
        .prompt({ sessionId, text: "follow-up" })
        .pipe(Effect.flip, Effect.timeout("500 millis"));
      assert.equal(second._tag, "TurnAlreadyRunning");

      yield* agent.session.interrupt(sessionId);
      yield* Stream.runCollect(first.output);
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("interrupt aborts the run and the turn still finishes", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const prompt = yield* agent.session.prompt({ sessionId, text: "hold" });
      const collected = yield* Effect.forkChild(Stream.runCollect(prompt.output));

      yield* agent.session.interrupt(sessionId);
      const chunks = yield* Fiber.join(collected);
      assert.equal(Array.from(chunks).at(-1)?.type, "finish");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("a failed prompt command leaves the session promptable", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const error = yield* agent.session.prompt({ sessionId, text: "fail" }).pipe(Effect.flip);
      assert.equal(error._tag, "PiRpcError");

      const prompt = yield* agent.session.prompt({ sessionId, text: "ping" });
      const chunks = yield* Stream.runCollect(prompt.output);
      assert.equal(Array.from(chunks).at(-1)?.type, "finish");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("a child crash evicts only that session and surfaces an error chunk", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const healthy = yield* agent.session.create({ cwd: "/tmp" });
      const doomed = yield* agent.session.create({ cwd: "/tmp" });

      const prompt = yield* agent.session.prompt({ sessionId: doomed.sessionId, text: "crash" });
      const chunks = yield* Stream.runCollect(prompt.output);
      assert.deepEqual(
        Array.from(chunks, (chunk) => chunk.type),
        ["start", "text-start", "text-delta", "error"],
      );

      yield* Effect.eventually(
        agent.session
          .respondPermission(doomed.sessionId, "missing", {
            type: "question",
            answers: [],
          })
          .pipe(
            Effect.flip,
            Effect.filterOrFail(
              (error) => error._tag === "HarnessSessionNotFound",
              () => new Error("crashed session was not evicted"),
            ),
          ),
      );

      // The sibling session's child is untouched.
      const sibling = yield* agent.session.prompt({ sessionId: healthy.sessionId, text: "ping" });
      const siblingChunks = yield* Stream.runCollect(sibling.output);
      assert.equal(Array.from(siblingChunks).at(-1)?.type, "finish");
      yield* agent.session.abort(healthy.sessionId);
    }),
  );

  it.effect("exposes prompt output through the unified adapter event stream", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const session = yield* makePiAdapter(agent).open({ cwd: "/tmp" });
      const collected = yield* Effect.forkChild(
        Stream.runCollect(
          session.events.pipe(
            Stream.takeUntil((event) => event.body.type === "session.turn.ended"),
          ),
        ),
      );

      const receipt = yield* session.prompt({ parts: [{ type: "text", text: "ping" }] });
      const events = yield* Fiber.join(collected);

      assert.equal(typeof receipt.turnId, "string");
      assert.deepEqual(
        Array.from(events, (event) => event.body.type),
        [
          "session.turn.started",
          "start",
          "text-start",
          "text-delta",
          "text-end",
          "finish",
          "session.turn.ended",
        ],
      );

      const capabilities = yield* session.getCapabilities;
      assert.deepEqual(capabilities, {
        supportsResume: true,
        supportsPermissions: false,
      });
      yield* session.close;
    }),
  );

  it.effect("reports a child crash while the adapter session is idle", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const session = yield* makePiAdapter(agent).open({ cwd: "/tmp" });
      const crashSeen = yield* Deferred.make<void>();
      yield* Stream.runForEach(session.events, (event) =>
        event.body.type === "session.crashed"
          ? Deferred.succeed(crashSeen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild);

      // Crash the child mid-turn without consuming the prompt output.
      yield* agent.session.prompt({ sessionId: session.sessionId, text: "crash" });
      yield* Effect.eventually(
        Deferred.isDone(crashSeen).pipe(
          Effect.filterOrFail(
            (done) => done,
            () => new Error("idle adapter session did not publish session.crashed"),
          ),
        ),
      );
    }),
  );
});
