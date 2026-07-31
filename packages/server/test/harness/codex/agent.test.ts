import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Stream } from "effect";

import type { CodexTransport } from "../../../src/harness/codex";
import { makeCodexAdapter } from "../../../src/harness/codex/adapter";
import { makeCodexAgent, makeCodexAgentWithDependencies } from "../../../src/harness/codex/agent";
import { CodexTransportError } from "../../../src/harness/errors";

const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
let cwd;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") {
    cwd = msg.params.cwd;
    send({ id: msg.id, result: { thread: { id: "th_1" } } });
    if (msg.params.cwd === "/tmp/idle-crash") setImmediate(() => process.exit(1));
  }
  if (msg.method === "turn/start") {
    if (cwd) fs.writeFileSync(path.join(cwd, "turn-model"), "model" in msg.params ? String(msg.params.model) : "<absent>");
    if (msg.params.input[0].text === "hold") {
      send({ id: msg.id, result: { turn: { id: "turn_hold" } } });
      send({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_hold" } } });
      return;
    }
    if (msg.params.input[0].text === "slow-start") {
      fs.writeFileSync(path.join(cwd, "turn-start-requested"), "");
      setTimeout(() => {
        fs.writeFileSync(path.join(cwd, "turn-start-replied"), "");
        send({ id: msg.id, result: { turn: { id: "turn_slow" } } });
        send({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_slow" } } });
      }, 50);
      return;
    }
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
  if (msg.method === "turn/steer") {
    process.exit(1);
    return;
  }
  if (msg.method === "turn/interrupt") {
    fs.writeFileSync(path.join(cwd, "turn-interrupted"), "");
    send({ id: msg.id, result: null });
  }
  if (msg.method === "thread/unsubscribe") send({ id: msg.id, result: null });
  if (msg.method === "thread/read") {
    if (msg.params.threadId === "th_missing") {
      send({ id: msg.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    const name = msg.params.threadId === "th_untitled" ? null : "My Thread";
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, name, preview: "first message", updatedAt: 1700 } } });
  }
});
`;

function makeFake(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const file = path.join(dir, "fake-codex.js");
  fs.writeFileSync(file, FAKE);
  fs.chmodSync(file, 0o755);
  return file;
}

layer(NodeServices.layer)("CodexAgent", (it) => {
  it.effect("does not let an old transport generation evict new sessions", () =>
    Effect.gen(function* () {
      const oldCrashGate = yield* Deferred.make<void>();
      const oldCrashStarted = yield* Deferred.make<void>();
      const controls: Array<{ readonly terminate: Effect.Effect<void> }> = [];
      let build = 0;
      const agent = yield* makeCodexAgentWithDependencies({
        beforeCrashCleanup: () =>
          Deferred.succeed(oldCrashStarted, undefined).pipe(
            Effect.andThen(Deferred.await(oldCrashGate)),
          ),
        makeTransport: () =>
          Effect.gen(function* () {
            build += 1;
            const generation = build;
            const terminated = yield* Ref.make(false);
            const termination = yield* Deferred.make<never, CodexTransportError>();
            const failure = new CodexTransportError({
              operation: `generation-${generation}`,
              cause: new Error(`generation ${generation} exited`),
            });
            const awaitTermination = Deferred.await(termination);
            yield* Effect.sync(() =>
              controls.push({
                terminate: Ref.set(terminated, true).pipe(
                  Effect.andThen(Deferred.fail(termination, failure)),
                  Effect.asVoid,
                ),
              }),
            );

            const request = <A>(method: string): Effect.Effect<A, CodexTransportError> => {
              const result =
                method === "thread/start"
                  ? { thread: { id: `th_${generation}` } }
                  : method === "turn/start"
                    ? { turn: { id: `turn_${generation}` } }
                    : {};
              return Effect.succeed(result as A);
            };
            return {
              request,
              notify: () => Effect.void,
              notifications: Stream.never,
              serverRequests: Stream.never,
              respond: () => Effect.void,
              respondError: () => Effect.void,
              isTerminated: Ref.get(terminated),
              awaitTermination,
            } satisfies CodexTransport;
          }),
      });

      const first = yield* agent.session.create({ cwd: "/tmp/first" });
      yield* controls[0]!.terminate;
      yield* Deferred.await(oldCrashStarted);
      const second = yield* agent.session.create({ cwd: "/tmp/second" });
      yield* Deferred.succeed(oldCrashGate, undefined);
      yield* Effect.eventually(
        agent.session
          .respondPermission(first.sessionId, "missing", {
            type: "tool",
            behavior: "deny",
          })
          .pipe(
            Effect.flip,
            Effect.filterOrFail(
              (error) => error._tag === "HarnessSessionNotFound",
              () => new Error("old generation session has not been cleaned up"),
            ),
          ),
      );

      const prompt = yield* agent.session.prompt({ sessionId: second.sessionId, text: "ping" });
      assert.equal(prompt.turnId, "turn_2");
      yield* agent.session.abort(second.sessionId);
    }),
  );

  it.effect("creates a thread and streams a full turn", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      assert.equal(sessionId, "th_1");

      const prompt = yield* agent.session.prompt({ sessionId, text: "ping" });
      const chunks = yield* Stream.runCollect(prompt.output);
      assert.deepEqual(
        Array.from(chunks, (chunk) => chunk.type),
        ["start", "text-start", "text-delta", "text-end", "finish"],
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("carries the model chosen at create time on the very first turn", () =>
    Effect.gen(function* () {
      // Codex fixes a model at thread/start and has no set-model call, so a
      // create-time choice can only reach it as a turn override. If this
      // regresses, picking a model silently does nothing.
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-"));
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const session = yield* makeCodexAdapter(agent).open({
        cwd: workspace,
        model: "gpt-5.6-luna",
      });

      yield* session.prompt({ parts: [{ type: "text", text: "ping" }] });

      assert.equal(fs.readFileSync(path.join(workspace, "turn-model"), "utf8"), "gpt-5.6-luna");
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the model unset when nothing was chosen", () =>
    Effect.gen(function* () {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-"));
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const session = yield* makeCodexAdapter(agent).open({ cwd: workspace });

      yield* session.prompt({ parts: [{ type: "text", text: "ping" }] });

      // Absent, not null or undefined: the key has to be missing entirely so
      // codex keeps the model from its own config.
      assert.equal(fs.readFileSync(path.join(workspace, "turn-model"), "utf8"), "<absent>");
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces thread metadata as session info", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const result = yield* makeCodexAdapter(agent).getSessionInfo("th_1");
      assert.equal(result._tag, "found");
      if (result._tag === "found") {
        assert.equal(result.info.title, "My Thread");
        // Codex timestamps are seconds; the adapter reports milliseconds.
        assert.equal(result.info.updatedAt, 1_700_000);
      }
    }),
  );

  it.effect("falls back to the thread preview when it has no title", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const result = yield* makeCodexAdapter(agent).getSessionInfo("th_untitled");
      assert.equal(result._tag, "found");
      if (result._tag === "found") assert.equal(result.info.title, "first message");
    }),
  );

  it.effect("maps an unknown thread to missing session info", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const result = yield* makeCodexAdapter(agent).getSessionInfo("th_missing");
      assert.equal(result._tag, "missing");
    }),
  );

  it.effect("reports a transport crash while the adapter session is idle", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const session = yield* makeCodexAdapter(agent).open({ cwd: "/tmp/idle-crash" });
      const crashSeen = yield* Deferred.make<void>();
      yield* Stream.runForEach(session.events, (event) =>
        event.body.type === "session.crashed"
          ? Deferred.succeed(crashSeen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* Effect.eventually(
        agent.session
          .respondPermission(session.sessionId, "missing", {
            type: "tool",
            behavior: "deny",
          })
          .pipe(
            Effect.flip,
            Effect.filterOrFail(
              (error) => error._tag === "HarnessSessionNotFound",
              () => new Error("native session has not crashed"),
            ),
          ),
      );
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      assert.equal(
        yield* Deferred.isDone(crashSeen),
        true,
        "idle adapter session did not publish session.crashed",
      );
    }),
  );

  it.effect("interrupts a turn requested while turn/start is still pending", () =>
    Effect.gen(function* () {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-starting-interrupt-"));
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd });
      const prompt = yield* Effect.forkChild(
        agent.session.prompt({ sessionId, text: "slow-start" }),
      );

      yield* Effect.eventually(
        Effect.sync(() => fs.existsSync(path.join(cwd, "turn-start-requested"))).pipe(
          Effect.filterOrFail(
            (requested) => requested,
            () => new Error("turn/start was not requested"),
          ),
        ),
      );
      yield* agent.session.interrupt(sessionId);
      yield* Fiber.join(prompt);
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      assert.equal(
        fs.existsSync(path.join(cwd, "turn-interrupted")),
        true,
        "turn/start completed without the pending interrupt",
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("interrupts the native turn when the prompt caller cancels during turn/start", () =>
    Effect.gen(function* () {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-starting-cancel-"));
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd });
      const prompt = yield* Effect.forkChild(
        agent.session.prompt({ sessionId, text: "slow-start" }),
      );

      yield* Effect.eventually(
        Effect.sync(() => fs.existsSync(path.join(cwd, "turn-start-requested"))).pipe(
          Effect.filterOrFail(
            (requested) => requested,
            () => new Error("turn/start was not requested"),
          ),
        ),
      );
      yield* Fiber.interrupt(prompt);
      yield* Effect.eventually(
        Effect.sync(() => fs.existsSync(path.join(cwd, "turn-start-replied"))).pipe(
          Effect.filterOrFail(
            (replied) => replied,
            () => new Error("turn/start did not reply"),
          ),
        ),
      );
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      assert.equal(
        fs.existsSync(path.join(cwd, "turn-interrupted")),
        true,
        "cancelled prompt left the native turn running",
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("unblocks a waiting prompt when the transport crashes", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      yield* agent.session.prompt({ sessionId, text: "hold" });
      const secondDone = yield* Deferred.make<void>();
      yield* agent.session.prompt({ sessionId, text: "steer-after-crash" }).pipe(
        Effect.exit,
        Effect.flatMap(() => Deferred.succeed(secondDone, undefined)),
        Effect.forkChild,
      );

      yield* Effect.eventually(
        agent.session
          .respondPermission(sessionId, "missing", {
            type: "tool",
            behavior: "deny",
          })
          .pipe(
            Effect.flip,
            Effect.filterOrFail(
              (error) => error._tag === "HarnessSessionNotFound",
              () => new Error("transport crash has not evicted the native session"),
            ),
          ),
      );
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      assert.equal(
        yield* Deferred.isDone(secondDone),
        true,
        "waiting prompt remained blocked on the crashed turn",
      );
    }),
  );

  it.effect("exposes prompt output through the unified adapter event stream", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const session = yield* makeCodexAdapter(agent).open({ cwd: "/tmp" });
      const collected = yield* Effect.forkChild(
        Stream.runCollect(
          session.events.pipe(
            Stream.takeUntil((event) => event.body.type === "session.turn.ended"),
          ),
        ),
      );

      const receipt = yield* session.prompt({ parts: [{ type: "text", text: "ping" }] });
      const events = yield* Fiber.join(collected);

      assert.equal(receipt.turnId, "turn_1");
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
      yield* session.close;
    }),
  );

  it.effect("keeps a retryable error inside the active turn", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const prompt = yield* agent.session.prompt({ sessionId, text: "retry" });
      const chunks = yield* Stream.runCollect(prompt.output);

      assert.ok(Array.from(chunks).some((chunk) => chunk.type === "error"));
      assert.equal(chunks.at(-1)?.type, "finish");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("does not let an abandoned session stall the shared transport", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });

      const prompt = yield* agent.session.prompt({ sessionId, text: "flood" });
      yield* Stream.runHead(prompt.output);
      const replacement = yield* agent.session
        .create({ cwd: "/tmp" })
        .pipe(Effect.timeout("2 seconds"));
      assert.equal(replacement.sessionId, "th_1");
      yield* agent.session.abort(replacement.sessionId);
    }),
  );

  it.effect("crashes existing sessions and lazily starts a replacement transport", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ cwd: "/tmp" });
      const prompt = yield* agent.session.prompt({ sessionId, text: "crash" });
      const chunks = yield* Stream.runCollect(prompt.output);
      assert.deepEqual(
        Array.from(chunks, (chunk) => chunk.type),
        ["start", "text-start", "text-delta", "error"],
      );

      const replacement = yield* agent.session.create({ cwd: "/tmp" });
      const replacementPrompt = yield* agent.session.prompt({
        sessionId: replacement.sessionId,
        text: "ping",
      });
      const replacementChunks = yield* Stream.runCollect(replacementPrompt.output);
      assert.equal(replacementChunks.at(-1)?.type, "finish");
      yield* agent.session.abort(replacement.sessionId);
    }),
  );
});
