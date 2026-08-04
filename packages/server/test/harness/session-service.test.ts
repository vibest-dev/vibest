import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isSessionScopedEvent, type SessionRef } from "@vibest/contract";
import type { UIMessage } from "ai";
import { Crypto, Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type EventBusShape, makeEventBus } from "../../src/events/event-bus";
import type {
  HarnessAgentAdapter,
  HarnessAgentSession,
  SessionInfoResult,
} from "../../src/harness/adapter";
import { TurnAlreadyRunning } from "../../src/harness/errors";
import { makeHarnessAgentRegistry } from "../../src/harness/registry";
import { makeHarnessAgentSessionManager } from "../../src/harness/session-manager";
import {
  type HarnessAgentSessionRepositoryShape,
  makeHarnessAgentSessionRepository,
} from "../../src/harness/session-repository";
import {
  type HarnessAgentSessionServiceShape,
  makeHarnessAgentSessionService,
} from "../../src/harness/session-service";
import { NodePlatformLayer } from "../platform";

type Spy = {
  open: Array<{ cwd: string }>;
  resume: Array<{ sessionId: string; cwd: string | undefined }>;
  close: Array<string>;
};

type Fixture = {
  readonly service: HarnessAgentSessionServiceShape;
  readonly repo: HarnessAgentSessionRepositoryShape;
  readonly bus: EventBusShape;
  readonly spy: Spy;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("HarnessAgentSessionService", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-svc-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const run = <A, E>(
    opts: {
      unavailable?: string;
      history?: ReadonlyArray<UIMessage>;
      // Feed the projection a turn: "open" leaves it in flight, "finished"
      // ends it (the runtime retains the completed buffer until the next turn).
      turn?: "open" | "finished";
      // The harness rejects every prompt (a turn is already running).
      promptFails?: boolean;
    },
    program: (fixture: Fixture) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const spy: Spy = { open: [], resume: [], close: [] };
          let opened = 0;
          const turnEvents = (sessionId: string) => {
            if (opts.turn === undefined) return Stream.empty;
            const drafts = [
              {
                harnessAgentId: "claude-code" as const,
                sessionId,
                body: { type: "session.turn.started" as const, sessionId, turnId: "turn-1" },
              },
              ...(opts.turn === "finished"
                ? [
                    {
                      harnessAgentId: "claude-code" as const,
                      sessionId,
                      body: {
                        type: "session.turn.ended" as const,
                        sessionId,
                        turnId: "turn-1",
                        outcome: "completed" as const,
                      },
                    },
                  ]
                : []),
            ];
            // Stream.never keeps the drain alive so the projection stays up.
            return Stream.concat(Stream.fromArray(drafts), Stream.never);
          };
          // Sessions drain an empty native stream by default — enough to
          // exercise the orchestration without any live projection state.
          const makeSession = (sessionId: string): HarnessAgentSession => ({
            sessionId,
            harnessAgentId: "claude-code",
            events: turnEvents(sessionId),
            prompt: opts.promptFails
              ? () => Effect.fail(new TurnAlreadyRunning({ sessionId }))
              : () => Effect.succeed({ turnId: "turn-1" }),
            setModel: () => Effect.void,
            setReasoningEffort: () => Effect.void,
            setPermissionMode: () => Effect.void,
            interrupt: Effect.void,
            respondToAgentRequest: () => Effect.void,
            getCapabilities: Effect.succeed({
              supportsResume: true,
              supportsSteering: false,
              supportsPermissions: false,
            }),
            ...(opts.history !== undefined ? { getMessages: Effect.succeed(opts.history) } : {}),
            close: Effect.sync(() => {
              spy.close.push(sessionId);
            }),
          });
          const adapter = {
            id: "claude-code",
            descriptor: { id: "claude-code", name: "Claude Code" },
            checkAvailability: Effect.sync(() =>
              opts.unavailable !== undefined
                ? { available: false, reason: opts.unavailable }
                : { available: true },
            ),
            permissionModes: [],
            open: ({ cwd }) =>
              Effect.sync(() => {
                spy.open.push({ cwd });
                opened += 1;
                return makeSession(`native-${opened}`);
              }),
            resume: ({ sessionId, cwd }) =>
              Effect.sync(() => {
                spy.resume.push({ sessionId, cwd });
                return makeSession(sessionId);
              }),
            getSessionInfo: () => Effect.succeed<SessionInfoResult>({ _tag: "unsupported" }),
          } satisfies HarnessAgentAdapter;
          const registry = makeHarnessAgentRegistry([adapter]);
          const bus = yield* makeEventBus();
          const manager = yield* makeHarnessAgentSessionManager(registry, bus);
          const repo = yield* makeHarnessAgentSessionRepository(
            path.join(home, "storage", "sessions"),
          );
          const crypto = yield* Crypto.Crypto;
          const service = makeHarnessAgentSessionService({
            manager,
            registry,
            repo,
            bus,
            newSessionId: crypto.randomUUIDv4.pipe(Effect.orDie),
          });
          return yield* program({ service, repo, bus, spy });
        }),
      ).pipe(Effect.provide(NodePlatformLayer)),
    );

  it("create passes the cwd through, generates a uuid sessionId, persists metadata", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        const stored = yield* fixture.repo.read(ref.projectId, ref.sessionId);
        return { ref, stored, spy: fixture.spy };
      }),
    );

    expect(result.ref.projectId).toBe("proj-a");
    expect(result.ref.harnessAgentId).toBe("claude-code");
    expect(result.ref.sessionId).toMatch(UUID_RE);
    // The harness saw the router-resolved cwd, never a projectId.
    expect(result.spy.open).toEqual([{ cwd: "/tmp/vibest-app" }]);
    // Metadata stores the native id, keyed by the server sessionId (filename).
    expect(result.stored.harnessSessionId).toBe("native-1");
    expect(result.stored.projectId).toBe("proj-a");
    expect(result.stored.cwd).toBe("/tmp/vibest-app");
  });

  it("create surfaces AgentUnavailable and writes no metadata", async () => {
    const result = await run({ unavailable: "not installed" }, (fixture) =>
      Effect.gen(function* () {
        const err = yield* Effect.flip(
          fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app"),
        );
        const listed = yield* fixture.repo.list("proj-a");
        return { err, listed };
      }),
    );
    expect(result.err._tag).toBe("AgentUnavailable");
    expect(result.listed).toHaveLength(0);
  });

  it("resume translates the ref to the native id and passes the cwd", async () => {
    const resumeSpy = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.close(ref);
        yield* fixture.service.resume(ref, "/tmp/vibest-app");
        return fixture.spy.resume;
      }),
    );
    expect(resumeSpy).toEqual([{ sessionId: "native-1", cwd: "/tmp/vibest-app" }]);
  });

  it("resume fails with SessionNotFound for an unknown session", async () => {
    const err = await run({}, (fixture) =>
      Effect.flip(
        fixture.service.resume(
          { projectId: "proj-a", harnessAgentId: "claude-code", sessionId: "missing" },
          "/tmp/vibest-app",
        ),
      ),
    );
    expect(err._tag).toBe("SessionNotFound");
  });

  it("resume fails with SessionRefMismatch when the ref's agent disagrees with metadata", async () => {
    const err = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* Effect.flip(
          fixture.service.resume({ ...ref, harnessAgentId: "codex" }, "/tmp/vibest-app"),
        );
      }),
    );
    expect(err._tag).toBe("SessionRefMismatch");
  });

  it("close translates the ref to the native id", async () => {
    const closeSpy = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.close(ref);
        return fixture.spy.close;
      }),
    );
    expect(closeSpy).toEqual(["native-1"]);
  });

  it("delete closes the native session and removes its metadata", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.delete(ref);
        const listed = yield* fixture.service.list("proj-a");
        return { listed, closeSpy: fixture.spy.close };
      }),
    );
    expect(result.closeSpy).toEqual(["native-1"]);
    expect(result.listed).toHaveLength(0);
  });

  it("list returns one summary per session, keyed by server sessionId", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const a = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        const b = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        const listed = yield* fixture.service.list("proj-a");
        return { a, b, listed };
      }),
    );
    expect(result.listed).toHaveLength(2);
    expect(result.listed.map((summary) => summary.sessionId).toSorted()).toEqual(
      [result.a.sessionId, result.b.sessionId].toSorted(),
    );
    // We own the record, so a session we created reads as history-available.
    expect(result.listed.every((summary) => summary.historyAvailable)).toBe(true);
  });

  it("getMessages reopens a closed session and reads through the live instance", async () => {
    const history: UIMessage[] = [{ id: "m1", role: "user", parts: [] }];
    const result = await run({ history }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.close(ref);
        const messages = yield* fixture.service.getMessages(ref, "/tmp/vibest-app");
        return { messages, resume: fixture.spy.resume };
      }),
    );
    // ensure resumed by native id with the router-resolved cwd before reading.
    expect(result.resume).toEqual([{ sessionId: "native-1", cwd: "/tmp/vibest-app" }]);
    expect(result.messages).toEqual(history);
  });

  const fourTurnHistory: UIMessage[] = [
    { id: "u1", role: "user", parts: [] },
    { id: "a1", role: "assistant", parts: [] },
    { id: "u2", role: "user", parts: [] },
    { id: "a2", role: "assistant", parts: [] },
  ];

  // The drain into the projection is async; poll until it has seen the turn.
  const waitForTurn = (
    fixture: Fixture,
    ref: SessionRef,
    done: (turn: { complete: boolean } | null) => boolean,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (true) {
        const turn = yield* fixture.service.getSnapshot(ref).pipe(
          Effect.map((snapshot) => snapshot.activeTurn),
          Effect.catchTag("SessionNotActive", () => Effect.succeed(null)),
        );
        if (done(turn)) return;
        yield* Effect.sleep("10 millis");
      }
    });

  it("getMessages trims the last user segment while a turn is in flight", async () => {
    const messages = await run({ history: fourTurnHistory, turn: "open" }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* waitForTurn(fixture, ref, (turn) => turn !== null && !turn.complete);
        return yield* fixture.service.getMessages(ref, "/tmp/vibest-app");
      }),
    );
    expect(messages.map((message) => message.id)).toEqual(["u1", "a1"]);
  });

  it("getMessages does not trim for a finished turn's retained buffer", async () => {
    const messages = await run({ history: fourTurnHistory, turn: "finished" }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* waitForTurn(fixture, ref, (turn) => turn !== null && turn.complete);
        return yield* fixture.service.getMessages(ref, "/tmp/vibest-app");
      }),
    );
    expect(messages.map((message) => message.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("getMessages fails CapabilityUnsupported when the harness has no history read", async () => {
    const err = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* Effect.flip(fixture.service.getMessages(ref, "/tmp/vibest-app"));
      }),
    );
    expect(err._tag).toBe("CapabilityUnsupported");
  });

  it("titles a session from its first prompt, collapsing whitespace", async () => {
    const listed = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.prompt({
          ref,
          parts: [{ type: "text", text: "  Fix the  login  bug " }],
        });
        return yield* fixture.service.list("proj-a");
      }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("Fix the login bug");
  });

  it("publishes session.updated with the collapsed title on the first prompt", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        // Subscribe after create so only the prompt's event is in flight; the
        // queue buffers it until take(1) pulls it — no forked drain, no race.
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* fixture.bus.subscribe({ kind: "global" });
            yield* fixture.service.prompt({
              ref,
              parts: [{ type: "text", text: "  Fix the  login  bug " }],
            });
            const items = yield* Stream.runCollect(Stream.take(stream, 1));
            return Array.from(items);
          }),
        );
      }),
    );
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.type).toBe("event");
    const event = item?.type === "event" ? item.event : undefined;
    expect(event && !isSessionScopedEvent(event)).toBe(true);
    expect(event?.type).toBe("session.updated");
    expect(event?.type === "session.updated" ? event.title : undefined).toBe("Fix the login bug");
  });

  // A session whose native stream stays open (turn: "open" concats
  // Stream.never) keeps its runtime alive — emit needs one; a drained-out
  // stream drops the runtime and the broadcast is silently skipped.
  const takePromptSubmitted = (fixture: Fixture, ref: SessionRef, promptInput: object) =>
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* fixture.bus.subscribe({ kind: "session", ref });
        yield* fixture.service.prompt({
          ref,
          parts: [{ type: "text", text: "hello there" }],
          ...promptInput,
        });
        const items = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(
              stream,
              (item) => item.type === "event" && item.event.type === "session.prompt.submitted",
            ),
            1,
          ),
        );
        const item = Array.from(items)[0];
        return item?.type === "event" ? item.event : undefined;
      }),
    );

  it("broadcasts session.prompt.submitted echoing the client messageId", async () => {
    const event = await run({ turn: "open" }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* takePromptSubmitted(fixture, ref, { messageId: "client-msg-1" });
      }),
    );
    expect(event).toMatchObject({
      type: "session.prompt.submitted",
      messageId: "client-msg-1",
      parts: [{ type: "text", text: "hello there" }],
    });
    // Shares the session's contiguous seq counter with harness events.
    expect(event && isSessionScopedEvent(event) ? event.seq : 0).toBeGreaterThan(0);
  });

  it("retains the accepted prompt in the runtime snapshot for mid-turn joiners", async () => {
    const snapshot = await run({ turn: "open" }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* takePromptSubmitted(fixture, ref, { messageId: "client-msg-1" });
        return yield* fixture.service.getSnapshot(ref);
      }),
    );
    // `session.prompt.submitted` is never re-sent, so the snapshot is the only
    // recovery for a client that attaches after it fired.
    expect(snapshot.activePrompt).toMatchObject({
      messageId: "client-msg-1",
      parts: [{ type: "text", text: "hello there" }],
    });
    expect(snapshot.activePrompt?.seq).toBeGreaterThan(0);
  });

  it("compensates a harness-rejected prompt: rejected event follows, no retained phantom", async () => {
    const result = await run({ turn: "open", promptFails: true }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* fixture.bus.subscribe({ kind: "session", ref });
            const rejection = yield* Effect.flip(
              fixture.service.prompt({
                ref,
                parts: [{ type: "text", text: "loser prompt" }],
                messageId: "loser-msg",
              }),
            );
            const items = yield* Stream.runCollect(
              Stream.take(
                Stream.filter(
                  stream,
                  (item) =>
                    item.type === "event" &&
                    (item.event.type === "session.prompt.submitted" ||
                      item.event.type === "session.prompt.rejected"),
                ),
                2,
              ),
            );
            const snapshot = yield* fixture.service.getSnapshot(ref);
            return {
              rejection,
              broadcast: Array.from(items).map((item) =>
                item.type === "event" ? item.event.type : item.type,
              ),
              activePrompt: snapshot.activePrompt,
            };
          }),
        );
      }),
    );
    expect(result.rejection._tag).toBe("TurnAlreadyRunning");
    // The submit broadcast still precedes the harness call (seq-order
    // invariant), so the rejection must compensate it — and the snapshot must
    // not retain the phantom for mid-turn joiners.
    expect(result.broadcast).toEqual(["session.prompt.submitted", "session.prompt.rejected"]);
    expect(result.activePrompt).toBeNull();
  });

  it("mints a messageId when the prompt carries none", async () => {
    const event = await run({ turn: "open" }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* takePromptSubmitted(fixture, ref, {});
      }),
    );
    expect(event?.type).toBe("session.prompt.submitted");
    expect(event && "messageId" in event ? event.messageId : undefined).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the first prompt's title; later prompts don't rename", async () => {
    const listed = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.prompt({ ref, parts: [{ type: "text", text: "first" }] });
        yield* fixture.service.prompt({ ref, parts: [{ type: "text", text: "second" }] });
        return yield* fixture.service.list("proj-a");
      }),
    );
    expect(listed[0]?.title).toBe("first");
  });

  it("lists a session with no title until its first prompt", async () => {
    const listed = await run({}, (fixture) =>
      Effect.gen(function* () {
        yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* fixture.service.list("proj-a");
      }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBeUndefined();
  });
});
