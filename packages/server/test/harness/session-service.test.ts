import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isSessionScopedEvent, type SessionRef } from "@vibest/contract";
import type { UIMessage } from "ai";
import {
  Crypto,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  References,
  type Scope,
  Stream,
} from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type EventBusShape, makeEventBus } from "../../src/events/event-bus";
import type {
  HarnessAgentAdapter,
  HarnessAgentRuntime,
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
import { structured, type LogRecord } from "../log-record";
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
  /**
   * A second service over the same storage and the same adapter — what a
   * server restart looks like from the session domain: the records survive,
   * nothing is live, and the spy keeps counting across both so "how many
   * processes has this session cost" stays answerable.
   */
  readonly restart: Effect.Effect<Fixture, never, Scope.Scope | FileSystem.FileSystem>;
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
      // The adapter reads history cold, off disk — no runtime involved.
      coldHistory?: ReadonlyArray<UIMessage>;
      // Feed the projection a turn: "open" leaves it in flight, "finished"
      // ends it (the runtime retains the completed buffer until the next turn).
      turn?: "open" | "finished";
      // The harness rejects every prompt (a turn is already running).
      promptFails?: boolean;
      // Optional close hook for exercising lifecycle contention.
      close?: (sessionId: string) => Promise<void>;
    },
    program: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>,
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
          const makeSession = (sessionId: string): HarnessAgentRuntime => ({
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
            }).pipe(
              Effect.andThen(
                opts.close === undefined
                  ? Effect.void
                  : Effect.promise(() => opts.close?.(sessionId) ?? Promise.resolve()),
              ),
            ),
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
              // An adapter sees `cwd` and never a `SessionRef` — this line is
              // the probe for whether the identity reaches it anyway.
              Effect.logDebug("adapter opening").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    spy.open.push({ cwd });
                    opened += 1;
                    return makeSession(`native-${opened}`);
                  }),
                ),
              ),
            resume: ({ sessionId, cwd }) =>
              Effect.sync(() => {
                spy.resume.push({ sessionId, cwd });
                return makeSession(sessionId);
              }),
            ...(opts.coldHistory !== undefined
              ? { getMessages: () => Effect.succeed(opts.coldHistory ?? []) }
              : {}),
            getSessionInfo: () => Effect.succeed<SessionInfoResult>({ _tag: "unsupported" }),
          } satisfies HarnessAgentAdapter;
          const registry = makeHarnessAgentRegistry([adapter]);
          const crypto = yield* Crypto.Crypto;
          const build: Effect.Effect<Fixture, never, Scope.Scope | FileSystem.FileSystem> =
            Effect.gen(function* () {
              const bus = yield* makeEventBus();
              const manager = yield* makeHarnessAgentSessionManager(registry, bus);
              const repo = yield* makeHarnessAgentSessionRepository(
                path.join(home, "storage", "sessions"),
              );
              const service = makeHarnessAgentSessionService({
                manager,
                registry,
                repo,
                bus,
                newSessionId: crypto.randomUUIDv4.pipe(Effect.orDie),
              });
              return { service, repo, bus, spy, restart: build };
            });
          return yield* program(yield* build);
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
    expect(result.stored.archived).toBe(false);
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

  it("prepare backfills the cwd and starts nothing", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.close(ref);
        // A record from before we stored cwd — the case the backfill exists for.
        const stored = yield* fixture.repo.read(ref.projectId, ref.sessionId);
        const { cwd: _dropped, ...withoutCwd } = stored;
        yield* fixture.repo.write(withoutCwd);

        yield* fixture.service.prepare(ref, "/tmp/vibest-app");
        const after = yield* fixture.repo.read(ref.projectId, ref.sessionId);
        return { cwd: after.cwd, resume: fixture.spy.resume, open: fixture.spy.open };
      }),
    );
    expect(result.cwd).toBe("/tmp/vibest-app");
    // Opening a session page costs no process — the whole point of `prepare`.
    expect(result.resume).toEqual([]);
    expect(result.open).toHaveLength(1);
  });

  it("prepare fails with SessionNotFound for an unknown session", async () => {
    const err = await run({}, (fixture) =>
      Effect.flip(
        fixture.service.prepare(
          { projectId: "proj-a", harnessAgentId: "claude-code", sessionId: "missing" },
          "/tmp/vibest-app",
        ),
      ),
    );
    expect(err._tag).toBe("SessionNotFound");
  });

  it("prepare fails with SessionRefMismatch when the ref's agent disagrees with metadata", async () => {
    const err = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* Effect.flip(
          fixture.service.prepare({ ...ref, harnessAgentId: "codex" }, "/tmp/vibest-app"),
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
        const listed = yield* fixture.service.list("proj-a", false);
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
        const listed = yield* fixture.service.list("proj-a", false);
        return { a, b, listed };
      }),
    );
    expect(result.listed).toHaveLength(2);
    expect(result.listed.map((summary) => summary.sessionId).toSorted()).toEqual(
      [result.a.sessionId, result.b.sessionId].toSorted(),
    );
    // We own the record, so a session we created reads as history-available.
    expect(result.listed.every((summary) => summary.historyAvailable)).toBe(true);
    expect(result.listed.every((summary) => !summary.archived)).toBe(true);
  });

  it("archives and restores a session, publishing each changed state", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* fixture.bus.subscribe({ kind: "global" });
            yield* fixture.service.archive(ref, true);
            const archived = yield* fixture.service.list("proj-a", true);
            const activeWhileArchived = yield* fixture.service.list("proj-a", false);
            yield* fixture.service.archive(ref, true); // idempotent: no duplicate event
            yield* fixture.service.archive(ref, false);
            const restored = yield* fixture.service.list("proj-a", false);
            const archivedAfterRestore = yield* fixture.service.list("proj-a", true);
            const items = yield* Stream.runCollect(Stream.take(stream, 2));
            return {
              archived,
              activeWhileArchived,
              restored,
              archivedAfterRestore,
              items: Array.from(items),
            };
          }),
        );
      }),
    );

    expect(result.archived[0]?.archived).toBe(true);
    expect(result.activeWhileArchived).toEqual([]);
    expect(result.restored[0]?.archived).toBe(false);
    expect(result.archivedAfterRestore).toEqual([]);
    expect(
      result.items.map((item) =>
        item.type === "event" && item.event.type === "session.archived"
          ? item.event.archived
          : undefined,
      ),
    ).toEqual([true, false]);
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
        const turn = yield* fixture.service
          .getSnapshot(ref)
          .pipe(Effect.map((snapshot) => snapshot.activeTurn));
        if (done(turn)) return;
        yield* Effect.sleep("10 millis");
      }
    });

  it("archives a running session and closes its live instance", async () => {
    const result = await run({ turn: "open" }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* waitForTurn(fixture, ref, (turn) => turn !== null && !turn.complete);
        yield* fixture.service.archive(ref, true);
        const active = yield* fixture.service.list("proj-a", false);
        const archived = yield* fixture.service.list("proj-a", true);
        return { active, archived, closed: fixture.spy.close.slice() };
      }),
    );

    expect(result.active).toEqual([]);
    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]?.status).toBeUndefined();
    expect(result.closed).toEqual(["native-1"]);
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

  it("getMessages reads cold through the adapter without starting anything", async () => {
    const history: UIMessage[] = [{ id: "m1", role: "user", parts: [] }];
    const result = await run({ coldHistory: history }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.close(ref);
        const messages = yield* fixture.service.getMessages(ref, "/tmp/vibest-app");
        return { messages, resume: fixture.spy.resume };
      }),
    );
    expect(result.messages).toEqual(history);
    // A harness that can read its own transcript is never asked for a process.
    expect(result.resume).toEqual([]);
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

  it("interrupt succeeds with nothing running instead of starting an agent", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.close(ref);
        yield* fixture.service.interrupt(ref);
        return fixture.spy.resume;
      }),
    );
    // The turn it would have stopped died with the process; resuming one in
    // order to interrupt it would be absurd.
    expect(result).toEqual([]);
  });

  it("respondToAgentRequest reports the request as gone with nothing running", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.close(ref);
        const err = yield* Effect.flip(
          fixture.service.respondToAgentRequest(ref, "req-1", {
            type: "tool",
            behavior: "allow",
          }),
        );
        return { err, resume: fixture.spy.resume };
      }),
    );
    expect(result.err._tag).toBe("AgentRequestUnavailable");
    expect(result.resume).toEqual([]);
  });

  // The bug this whole shape exists for: a browser left open across a server
  // restart used to hit SESSION_NOT_ACTIVE on every snapshot and retry forever,
  // because nothing on the observation path could make the error go away.
  it("a restarted server answers for a session it has never touched", async () => {
    const history: UIMessage[] = [{ id: "m1", role: "user", parts: [] }];
    const result = await run({ coldHistory: history }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        const restarted = yield* fixture.restart;

        yield* restarted.service.prepare(ref, "/tmp/vibest-app");
        const status = yield* restarted.service.getStatus(ref);
        const snapshot = yield* restarted.service.getSnapshot(ref);
        const listed = yield* restarted.service.list("proj-a", false);
        const messages = yield* restarted.service.getMessages(ref, "/tmp/vibest-app");
        return { ref, status, snapshot, listed, messages, spy: fixture.spy };
      }),
    );

    // Everything a reattaching client asks for is answerable …
    expect(result.status).toEqual({ phase: "idle" });
    expect(result.snapshot.cursor).toBe(0);
    expect(result.snapshot.activeTurn).toBeNull();
    expect(result.messages).toEqual(history);
    // … a session nothing has touched carries no status at all, so the sidebar
    // does not light up every row as active …
    expect(result.listed).toHaveLength(1);
    expect(result.listed[0]?.status).toBeUndefined();
    // … and none of it started an agent. `open` is the one at create time.
    expect(result.spy.open).toHaveLength(1);
    expect(result.spy.resume).toEqual([]);
  });

  // `turn: "finished"` keeps the fake's event stream open, which is what a real
  // runtime does: a stream that ends means the agent is done and the session
  // lets it go, so an empty one would be released between the two prompts.
  it("the first prompt after a restart starts exactly one agent", async () => {
    const result = await run({ turn: "finished" }, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        const restarted = yield* fixture.restart;
        yield* restarted.service.prepare(ref, "/tmp/vibest-app");

        yield* restarted.service.prompt({ ref, parts: [{ type: "text", text: "hello" }] });
        yield* restarted.service.prompt({ ref, parts: [{ type: "text", text: "again" }] });
        return fixture.spy.resume;
      }),
    );
    // Two prompts, one resume: the session keeps the runtime it acquired.
    expect(result).toEqual([{ sessionId: "native-1", cwd: "/tmp/vibest-app" }]);
  });

  it("titles a session from its first prompt, collapsing whitespace", async () => {
    const listed = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.prompt({
          ref,
          parts: [{ type: "text", text: "  Fix the  login  bug " }],
        });
        return yield* fixture.service.list("proj-a", false);
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
        return yield* fixture.service.list("proj-a", false);
      }),
    );
    expect(listed[0]?.title).toBe("first");
  });

  it("lists a session with no title until its first prompt", async () => {
    const listed = await run({}, (fixture) =>
      Effect.gen(function* () {
        yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* fixture.service.list("proj-a", false);
      }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBeUndefined();
  });

  // The lifecycle log is what a periodic read of `$VIBEST_HOME/logs` is for:
  // read on its own it says what was worked on, when, and where. It has to hold
  // together across the whole span of a session, so it is asserted as a
  // sequence rather than one line at a time.
  it("logs each lifecycle boundary once, in order, at info", async () => {
    const records: Array<LogRecord> = [];
    await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.archive(ref, true);
        yield* fixture.service.delete(ref);
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.map(structured, (record) => {
              records.push(record);
            }),
          ]),
        ),
      ),
    );

    // Only lifecycle events are logs. The native `harness.open` span correlates
    // logs inside it but does not synthesize its own completion record.
    expect(records.map((record) => record.annotations.event)).toEqual([
      "session.created",
      "session.archived",
      "session.deleted",
    ]);
    expect(records.every((record) => record.level === "INFO")).toBe(true);

    const created = records[0];
    expect(created?.annotations.cwd).toBe("/tmp/vibest-app");
    expect(created?.annotations.harnessSessionId).toBe("native-1");
    expect(created?.annotations.projectId).toBe("proj-a");
    // Every line carries the id, so one session's whole life greps out of a
    // file holding many.
    const sessionId = created?.annotations.sessionId;
    expect(typeof sessionId).toBe("string");
    expect(records.every((r) => r.annotations.sessionId === sessionId)).toBe(true);
  });

  // The identity is bound once at the service boundary, not repeated at each
  // log site — so a layer that has never heard of a `SessionRef` (an adapter
  // sees `cwd` and nothing else) still writes lines that grep out with the
  // session's own. This is the test that keeps that wrap from being "tidied"
  // back into per-site annotations.
  it("puts the session's identity on what the layers below it log", async () => {
    const records: Array<LogRecord> = [];
    await run({}, (fixture) =>
      fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app").pipe(
        Effect.provide(
          Layer.merge(
            Logger.layer([
              Logger.map(structured, (record) => {
                records.push(record);
              }),
            ]),
            Layer.succeed(References.MinimumLogLevel, "Debug"),
          ),
        ),
      ),
    );

    const adapterLine = records.find((record) => record.message === "adapter opening");
    expect(adapterLine).toBeDefined();
    expect(adapterLine?.annotations.projectId).toBe("proj-a");
    expect(adapterLine?.annotations.harnessAgentId).toBe("claude-code");
    expect(adapterLine?.annotations.sessionId).toMatch(UUID_RE);
  });

  // The rename used to be broadcast-only, so every client showed the new title
  // until the next list load read the old one back off disk.
  it("rename persists the title across a restart", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.rename(ref, "Login bug");
        const listed = yield* fixture.service.list("proj-a", false);
        const restarted = yield* fixture.restart;
        return { listed, afterRestart: yield* restarted.service.list("proj-a", false) };
      }),
    );
    expect(result.listed[0]?.title).toBe("Login bug");
    expect(result.afterRestart[0]?.title).toBe("Login bug");
  });

  it("publishes session.renamed per change, and nothing for a no-op rename", async () => {
    const result = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* fixture.bus.subscribe({ kind: "global" });
            yield* fixture.service.rename(ref, "First title");
            yield* fixture.service.rename(ref, "First title"); // no-op: no event
            yield* fixture.service.rename(ref, "Second title");
            const items = yield* Stream.runCollect(Stream.take(stream, 2));
            return Array.from(items);
          }),
        );
      }),
    );
    expect(
      result.map((item) =>
        item.type === "event" && item.event.type === "session.renamed"
          ? item.event.title
          : item.type,
      ),
    ).toEqual(["First title", "Second title"]);
  });

  // The title is the user's once they have chosen one: the first-prompt stamp
  // only fills a record that has none.
  it("keeps a hand-chosen title through the first prompt", async () => {
    const listed = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* fixture.service.rename(ref, "Login bug");
        yield* fixture.service.prompt({ ref, parts: [{ type: "text", text: "first" }] });
        return yield* fixture.service.list("proj-a", false);
      }),
    );
    expect(listed[0]?.title).toBe("Login bug");
  });

  it("preserves rename and archive changes made concurrently", async () => {
    const stored = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* Effect.all(
          [fixture.service.rename(ref, "Login bug"), fixture.service.archive(ref, true)],
          { concurrency: "unbounded" },
        );
        return yield* fixture.repo.read(ref.projectId, ref.sessionId);
      }),
    );
    expect(stored.title).toBe("Login bug");
    expect(stored.archived).toBe(true);
  });

  it("keeps the manual title when rename races the first prompt stamp", async () => {
    const listed = await run({}, (fixture) =>
      Effect.gen(function* () {
        const ref = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
        yield* Effect.all(
          [
            fixture.service.prompt({ ref, parts: [{ type: "text", text: "automatic title" }] }),
            fixture.service.rename(ref, "Login bug"),
          ],
          { concurrency: "unbounded" },
        );
        return yield* fixture.service.list("proj-a", false);
      }),
    );
    expect(listed[0]?.title).toBe("Login bug");
  });

  it("does not let one slow session close stall another session's rename", async () => {
    let releaseClose!: () => void;
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    const closeReleased = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const stored = await run(
      {
        close: async (sessionId) => {
          if (sessionId !== "native-1") return;
          markCloseStarted();
          await closeReleased;
        },
      },
      (fixture) =>
        Effect.gen(function* () {
          const slow = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
          const other = yield* fixture.service.create("proj-a", "claude-code", "/tmp/vibest-app");
          const archiving = yield* Effect.forkChild(fixture.service.archive(slow, true));
          yield* Effect.promise(() => closeStarted);
          yield* fixture.service.rename(other, "Still responsive");
          releaseClose();
          yield* Fiber.join(archiving);
          return yield* fixture.repo.read(other.projectId, other.sessionId);
        }),
    );

    expect(stored.title).toBe("Still responsive");
  });
});
