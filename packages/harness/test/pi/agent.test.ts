import * as NodeAssert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";

import { makePiAgent } from "../../src/pi/agent";
import { makePiAdapter } from "../../src/pi/runtime/adapter";

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
    send({ id: msg.id, type: "response", command: "steer", success: true });
    if (holding) { holding = false; settle(); }
    return;
  }
  if (msg.type === "abort") {
    send({ id: msg.id, type: "response", command: "abort", success: true });
    if (holding) { holding = false; settle(assistant({ stopReason: "aborted" })); }
    return;
  }
  if (msg.type !== "prompt") return;
  const text = msg.message;
  if (text === "fail") { send({ id: msg.id, type: "response", command: "prompt", success: false, error: "cannot prompt" }); return; }
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
  const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
  const file = join(dir, "fake-pi.js");
  writeFileSync(file, FAKE);
  chmodSync(file, 0o755);
  return file;
}

layer(NodeServices.layer)("PiAgent", (it) => {
  it.effect("creates a session and streams a full turn", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
      NodeAssert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);

      const prompt = yield* agent.session.prompt({ sessionId, text: "ping" });
      NodeAssert.equal(prompt.started, true);
      const chunks = yield* Stream.runCollect(prompt.output);
      NodeAssert.deepStrictEqual(
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
        workspacePath: "/tmp",
      });
      NodeAssert.equal(sessionId, "custom-id");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("fails to open when pi cannot resolve the session", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const error = yield* agent.session
        .resume({ sessionId: "missing-session", workspacePath: "/tmp" })
        .pipe(Effect.flip);
      NodeAssert.equal(error._tag, "AgentProcessExited");
    }),
  );

  it.effect("streams tool executions as typed tool chunks", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
      const prompt = yield* agent.session.prompt({ sessionId, text: "tool" });
      const chunks = yield* Stream.runCollect(prompt.output);
      NodeAssert.deepStrictEqual(
        Array.from(chunks, (chunk) => chunk.type),
        ["start", "tool-input-available", "tool-output-available", "finish"],
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("round-trips a blocking extension UI request through respondPermission", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
      const requestFiber = yield* Stream.runHead(agent.session.requestPermission(sessionId)).pipe(
        Effect.forkChild,
      );
      const prompt = yield* agent.session.prompt({ sessionId, text: "confirm" });
      const collected = yield* Effect.forkChild(Stream.runCollect(prompt.output));

      const request = yield* Fiber.join(requestFiber);
      NodeAssert.equal(request._tag, "Some");
      if (request._tag !== "Some") return;
      NodeAssert.deepStrictEqual(request.value, {
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
      NodeAssert.equal(accepted, true);

      const chunks = yield* Fiber.join(collected);
      const deltas = Array.from(chunks).filter((chunk) => chunk.type === "text-delta");
      NodeAssert.ok(
        deltas.some((chunk) => "delta" in chunk && chunk.delta === "confirmed:true"),
        "the confirm answer did not reach the pi child",
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("steers an active turn instead of starting a new one", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
      const first = yield* agent.session.prompt({ sessionId, text: "hold" });
      NodeAssert.equal(first.started, true);

      const second = yield* agent.session.prompt({ sessionId, text: "also do this" });
      NodeAssert.equal(second.started, false);
      NodeAssert.equal(second.turnId, first.turnId);

      const chunks = yield* Stream.runCollect(first.output);
      NodeAssert.equal(Array.from(chunks).at(-1)?.type, "finish");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("interrupt aborts the run and the turn still finishes", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
      const prompt = yield* agent.session.prompt({ sessionId, text: "hold" });
      const collected = yield* Effect.forkChild(Stream.runCollect(prompt.output));

      yield* agent.session.interrupt(sessionId);
      const chunks = yield* Fiber.join(collected);
      NodeAssert.equal(Array.from(chunks).at(-1)?.type, "finish");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("a failed prompt command leaves the session promptable", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
      const error = yield* agent.session.prompt({ sessionId, text: "fail" }).pipe(Effect.flip);
      NodeAssert.equal(error._tag, "PiRpcError");

      const prompt = yield* agent.session.prompt({ sessionId, text: "ping" });
      const chunks = yield* Stream.runCollect(prompt.output);
      NodeAssert.equal(Array.from(chunks).at(-1)?.type, "finish");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("a child crash evicts only that session and surfaces an error chunk", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const healthy = yield* agent.session.create({ workspacePath: "/tmp" });
      const doomed = yield* agent.session.create({ workspacePath: "/tmp" });

      const prompt = yield* agent.session.prompt({ sessionId: doomed.sessionId, text: "crash" });
      const chunks = yield* Stream.runCollect(prompt.output);
      NodeAssert.deepStrictEqual(
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
              (error) => error._tag === "SessionNotFound",
              () => new Error("crashed session was not evicted"),
            ),
          ),
      );

      // The sibling session's child is untouched.
      const sibling = yield* agent.session.prompt({ sessionId: healthy.sessionId, text: "ping" });
      const siblingChunks = yield* Stream.runCollect(sibling.output);
      NodeAssert.equal(Array.from(siblingChunks).at(-1)?.type, "finish");
      yield* agent.session.abort(healthy.sessionId);
    }),
  );

  it.effect("exposes prompt output through the unified adapter event stream", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const session = yield* makePiAdapter(agent).open({ workspacePath: "/tmp" });
      const collected = yield* Effect.forkChild(
        Stream.runCollect(
          session.events.pipe(
            Stream.takeUntil((event) => event.body.type === "session.turn.ended"),
          ),
        ),
      );

      const receipt = yield* session.prompt({ parts: [{ type: "text", text: "ping" }] });
      const events = yield* Fiber.join(collected);

      NodeAssert.equal(receipt.cursor, 0);
      NodeAssert.equal(receipt.started, true);
      NodeAssert.deepStrictEqual(
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
      NodeAssert.deepStrictEqual(capabilities, {
        supportsResume: true,
        supportsSteering: true,
        supportsPermissions: false,
      });
      yield* session.close;
    }),
  );

  it.effect("reports a child crash while the adapter session is idle", () =>
    Effect.gen(function* () {
      const agent = yield* makePiAgent({ executablePath: makeFake() });
      const session = yield* makePiAdapter(agent).open({ workspacePath: "/tmp" });
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
