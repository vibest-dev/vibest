import * as NodeAssert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Stream } from "effect";

import { makeCodexAgent, makeCodexAgentWithDependencies } from "../../src/codex/agent";
import type { CodexTransport } from "../../src/codex/runtime";
import { makeCodexAdapter } from "../../src/codex/runtime/adapter";
import { CodexTransportError } from "../../src/runtime/errors";

const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
let workspacePath;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") {
    workspacePath = msg.params.cwd;
    send({ id: msg.id, result: { thread: { id: "th_1" } } });
    if (msg.params.cwd === "/tmp/idle-crash") setImmediate(() => process.exit(1));
  }
  if (msg.method === "turn/start") {
    if (msg.params.input[0].text === "hold") {
      send({ id: msg.id, result: { turn: { id: "turn_hold" } } });
      send({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_hold" } } });
      return;
    }
    if (msg.params.input[0].text === "slow-start") {
      fs.writeFileSync(path.join(workspacePath, "turn-start-requested"), "");
      setTimeout(() => {
        fs.writeFileSync(path.join(workspacePath, "turn-start-replied"), "");
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
    fs.writeFileSync(path.join(workspacePath, "turn-interrupted"), "");
    send({ id: msg.id, result: null });
  }
  if (msg.method === "thread/unsubscribe") send({ id: msg.id, result: null });
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

      const first = yield* agent.session.create({ workspacePath: "/tmp/first" });
      yield* controls[0]!.terminate;
      yield* Deferred.await(oldCrashStarted);
      const second = yield* agent.session.create({ workspacePath: "/tmp/second" });
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
              (error) => error._tag === "SessionNotFound",
              () => new Error("old generation session has not been cleaned up"),
            ),
          ),
      );

      const prompt = yield* agent.session.prompt({ sessionId: second.sessionId, text: "ping" });
      NodeAssert.equal(prompt.turnId, "turn_2");
      yield* agent.session.abort(second.sessionId);
    }),
  );

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

  it.effect("reports a transport crash while the adapter session is idle", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const session = yield* makeCodexAdapter(agent).open({ workspacePath: "/tmp/idle-crash" });
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
              (error) => error._tag === "SessionNotFound",
              () => new Error("native session has not crashed"),
            ),
          ),
      );
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      NodeAssert.equal(
        yield* Deferred.isDone(crashSeen),
        true,
        "idle adapter session did not publish session.crashed",
      );
    }),
  );

  it.effect("interrupts a turn requested while turn/start is still pending", () =>
    Effect.gen(function* () {
      const workspacePath = mkdtempSync(join(tmpdir(), "codex-starting-interrupt-"));
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath });
      const prompt = yield* Effect.forkChild(
        agent.session.prompt({ sessionId, text: "slow-start" }),
      );

      yield* Effect.eventually(
        Effect.sync(() => existsSync(join(workspacePath, "turn-start-requested"))).pipe(
          Effect.filterOrFail(
            (requested) => requested,
            () => new Error("turn/start was not requested"),
          ),
        ),
      );
      yield* agent.session.interrupt(sessionId);
      yield* Fiber.join(prompt);
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      NodeAssert.equal(
        existsSync(join(workspacePath, "turn-interrupted")),
        true,
        "turn/start completed without the pending interrupt",
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("interrupts the native turn when the prompt caller cancels during turn/start", () =>
    Effect.gen(function* () {
      const workspacePath = mkdtempSync(join(tmpdir(), "codex-starting-cancel-"));
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath });
      const prompt = yield* Effect.forkChild(
        agent.session.prompt({ sessionId, text: "slow-start" }),
      );

      yield* Effect.eventually(
        Effect.sync(() => existsSync(join(workspacePath, "turn-start-requested"))).pipe(
          Effect.filterOrFail(
            (requested) => requested,
            () => new Error("turn/start was not requested"),
          ),
        ),
      );
      yield* Fiber.interrupt(prompt);
      yield* Effect.eventually(
        Effect.sync(() => existsSync(join(workspacePath, "turn-start-replied"))).pipe(
          Effect.filterOrFail(
            (replied) => replied,
            () => new Error("turn/start did not reply"),
          ),
        ),
      );
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      NodeAssert.equal(
        existsSync(join(workspacePath, "turn-interrupted")),
        true,
        "cancelled prompt left the native turn running",
      );
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("unblocks a waiting prompt when the transport crashes", () =>
    Effect.gen(function* () {
      const agent = yield* makeCodexAgent({ executablePath: makeFake() });
      const { sessionId } = yield* agent.session.create({ workspacePath: "/tmp" });
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
              (error) => error._tag === "SessionNotFound",
              () => new Error("transport crash has not evicted the native session"),
            ),
          ),
      );
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      NodeAssert.equal(
        yield* Deferred.isDone(secondDone),
        true,
        "waiting prompt remained blocked on the crashed turn",
      );
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
