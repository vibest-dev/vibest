import type {
  HarnessAgentId,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEventBody,
  SessionStatus,
} from "@vibest/contract";
import {
  Context,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Ref,
  Scope,
  Semaphore,
} from "effect";

import { EventBus, type EventBusShape } from "../events/event-bus";
import type { CreateSessionInput, HarnessAgentRuntime } from "./adapter";
import {
  AgentOpenError,
  type AgentOperationError,
  AgentUnavailable,
  type CreateSessionError,
  HarnessSessionNotFound,
  type ResumeSessionError,
  SessionClosed,
  SessionNotResumable,
} from "./errors";
import type { HarnessAgentRegistryShape } from "./registry";
import { HarnessAgentRegistry } from "./registry";
import {
  type AcquireRuntime,
  type HarnessAgentSessionShape,
  makeHarnessAgentSession,
} from "./session";
import { initialSessionState, toSnapshot, toStatus } from "./session-fold";
import type { ResumeManagedSessionInput, SessionConfig } from "./session-io";
import { SessionRecoveryStore } from "./session-recovery";

/**
 * The sole owner of live session state: one {@link HarnessAgentSessionShape}
 * per ref, each optionally holding a runtime. The manager's own job is narrow —
 * keep the table, and turn "which harness, which native id, which cwd" into
 * the `acquire` a session runs when it decides it needs a runtime.
 *
 * It remains the single caller of `adapter.open` / `adapter.resume`: every
 * acquisition goes through one session's lifecycle lock, so an adapter is
 * never asked to open the same session twice concurrently. That invariant is
 * load-bearing for pi, whose `openSession` blind-writes its own table.
 *
 * Vocabulary: everything here is addressed by {@link SessionRef}, which is
 * carried opaquely — stamped onto wire events and used as the map key — never
 * interpreted. The agent-native session id survives only as a value the
 * adapters trade in; adapters never see the ref.
 */

export type HarnessAgentSessionManagerShape = {
  /**
   * Open a fresh native session via the adapter and take ownership of it. The
   * one eager path: a session that does not exist yet has no native id to
   * resume by, so creating it *is* opening it. `config` becomes the session's
   * config, so the create-time choice reaches this runtime and every later one
   * by the same seeding path.
   */
  readonly open: (
    harnessAgentId: HarnessAgentId,
    input: CreateSessionInput,
    config: SessionConfig,
    ref: SessionRef,
  ) => Effect.Effect<HarnessAgentRuntime, CreateSessionError>;
  /**
   * The session's runtime, resuming one via the adapter if it holds none.
   * Single-flight per session; a failure leaves the session observable and
   * lets a later call retry. This is the only path that starts a process for
   * an existing session.
   */
  readonly ensureRuntime: (
    input: ResumeManagedSessionInput,
    ref: SessionRef,
  ) => Effect.Effect<HarnessAgentRuntime, ResumeSessionError>;
  /**
   * The runtime a session already holds; fails when it holds none. Never
   * acquires — callers that merely want to talk to a running agent must not
   * start one.
   */
  readonly get: (ref: SessionRef) => Effect.Effect<HarnessAgentRuntime, HarnessSessionNotFound>;
  /** The same lookup as {@link get}, for callers that have something else to do
   * when nothing is running rather than an error to raise. */
  readonly peek: (ref: SessionRef) => Effect.Effect<HarnessAgentRuntime | undefined>;
  /**
   * Record what a session's config should be, and push it to its runtime if one
   * is live. A write, so it materializes the session: choosing a model for a
   * session that isn't running is a legitimate thing to do, and every runtime
   * the session acquires afterwards is seeded with the choice.
   */
  readonly setConfig: (
    ref: SessionRef,
    patch: SessionConfig,
  ) => Effect.Effect<void, SessionClosed | AgentOperationError>;
  /**
   * Close and forget a session — runtime and session state alike; idempotent.
   * This is the only path that discards a crashed session (a crash alone
   * releases the runtime but keeps the session queryable at phase "crashed"
   * for reconnecting clients).
   */
  readonly close: (ref: SessionRef) => Effect.Effect<void>;
  /**
   * The status/snapshot of a session. Total on purpose: a ref with nothing
   * live in memory — the ordinary state of every persisted session after a
   * server restart — reads as idle at cursor 0 rather than failing. That is
   * what lets a client attach, snapshot, and subscribe without anything
   * starting a process on its behalf.
   *
   * Neither call creates a session; only the write paths do.
   */
  readonly status: (ref: SessionRef) => Effect.Effect<SessionStatus>;
  readonly snapshot: (ref: SessionRef) => Effect.Effect<SessionRuntimeSnapshot>;
  /**
   * The status of a session that is live in memory, or `undefined` when it is
   * not. The distinction `status` deliberately erases, for the one caller that
   * needs it: `list` must show an untouched session as having no status at
   * all, not as a freshly idle one.
   */
  readonly liveStatus: (ref: SessionRef) => Effect.Effect<SessionStatus | undefined>;
  /**
   * Inject a server-originated session event into the session's stream — same
   * seq counter and fan-out as harness events (see session `emit`). A write,
   * so it materializes the session if this is the first thing to touch it.
   */
  readonly emit: (ref: SessionRef, body: SessionScopedEventBody) => Effect.Effect<void>;
};

export class HarnessAgentSessionManager extends Context.Service<
  HarnessAgentSessionManager,
  HarnessAgentSessionManagerShape
>()("HarnessAgentSessionManager") {}

/**
 * A live session, or the fact that one is on its way out. Both live in the
 * same table so "does this ref have a session" is a single atomic question:
 * anything that wants to write waits behind an in-flight close instead of
 * racing it, which is what keeps `adapter.open` / `adapter.resume`
 * single-caller per session even while one is being torn down.
 */
type SessionEntry =
  | { readonly _tag: "Live"; readonly session: HarnessAgentSessionShape }
  | {
      readonly _tag: "Closing";
      readonly done: Deferred.Deferred<void>;
      readonly streamId: string;
    };

type CloseStep =
  | {
      readonly _tag: "Release";
      readonly session: HarnessAgentSessionShape;
      readonly done: Deferred.Deferred<void>;
    }
  | { readonly _tag: "Await"; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "Done" };

type SessionForStep =
  | { readonly _tag: "Ready"; readonly session: HarnessAgentSessionShape }
  | { readonly _tag: "AwaitClose"; readonly done: Deferred.Deferred<void> };

type MakeSession = typeof makeHarnessAgentSession;

export const makeHarnessAgentSessionManager = (
  registry: HarnessAgentRegistryShape,
  bus: EventBusShape,
  makeSession: MakeSession = makeHarnessAgentSession,
): Effect.Effect<
  HarnessAgentSessionManagerShape,
  never,
  Scope.Scope | FileSystem.FileSystem | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    // An adapter's availability check reads the filesystem; bind it once here
    // so the manager's own methods stay R-free. `provideService` rather than
    // `provide(Effect.context())` — the latter captures the whole layer-build
    // context, `ownerScope` included, and wins the merge over a caller's.
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const serverStreamId = yield* crypto.randomUUIDv4.pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.die(new Error("invariant: platform RNG failed minting a stream id", { cause })),
      ),
    );
    // The server id changes on process/manager restart. A session's epoch stays
    // stable while it is absent and across its first materialization, then
    // advances exactly once when that live session closes.
    const streamEpochs = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const streamIdFor = (ref: SessionRef): Effect.Effect<string> =>
      Ref.get(streamEpochs).pipe(
        Effect.map((epochs) => {
          const epoch = epochs.get(ref.sessionId) ?? 0;
          return `${serverStreamId}:${ref.sessionId.length}:${ref.sessionId}:${epoch}`;
        }),
      );
    const advanceStreamEpoch = (ref: SessionRef): Effect.Effect<void> =>
      Ref.update(streamEpochs, (current) => {
        const next = new Map(current);
        next.set(ref.sessionId, (current.get(ref.sessionId) ?? 0) + 1);
        return next;
      });
    // Our sessionId → the session that owns its observable state.
    const sessions = yield* Ref.make<ReadonlyMap<string, SessionEntry>>(new Map());
    // Session construction is only a handful of Refs. Keep lookup, construction,
    // and install under one permit so close cannot observe an absent table entry
    // and return while an already-started materialization installs afterwards.
    const sessionTableLock = Semaphore.makeUnsafe(1);

    const sessionFor = (ref: SessionRef): Effect.Effect<HarnessAgentSessionShape> =>
      Effect.suspend(() =>
        sessionTableLock
          .withPermit(
            Ref.get(sessions).pipe(
              Effect.flatMap((current): Effect.Effect<SessionForStep> => {
                const entry = current.get(ref.sessionId);
                if (entry?._tag === "Live") {
                  return Effect.succeed({ _tag: "Ready", session: entry.session });
                }
                if (entry?._tag === "Closing") {
                  return Effect.succeed({ _tag: "AwaitClose", done: entry.done });
                }
                return streamIdFor(ref).pipe(
                  Effect.flatMap((streamId) => makeSession(ref, streamId, bus)),
                  Effect.provideService(Scope.Scope, ownerScope),
                  Effect.flatMap((session) =>
                    Ref.update(sessions, (latest) =>
                      new Map(latest).set(ref.sessionId, { _tag: "Live", session }),
                    ).pipe(Effect.as({ _tag: "Ready", session } as const)),
                  ),
                );
              }),
            ),
          )
          .pipe(
            Effect.flatMap((step) =>
              step._tag === "Ready"
                ? Effect.succeed(step.session)
                : Deferred.await(step.done).pipe(Effect.andThen(sessionFor(ref))),
            ),
          ),
      );

    /** Read through a live session, or answer for one that isn't there. One on
     * its way out reads as absent — its state is about to stop existing. */
    const withSession = <A>(
      ref: SessionRef,
      use: (session: HarnessAgentSessionShape) => Effect.Effect<A>,
      absent: A,
    ): Effect.Effect<A> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const entry = current.get(ref.sessionId);
          return entry?._tag === "Live" ? use(entry.session) : Effect.succeed(absent);
        }),
      );

    const checkAvailable = (harnessAgentId: HarnessAgentId) =>
      registry.get(harnessAgentId).pipe(
        Effect.tap((adapter) =>
          adapter.checkAvailability.pipe(
            Effect.flatMap((availability) =>
              availability.available
                ? Effect.void
                : Effect.fail(
                    new AgentUnavailable({
                      harnessAgentId,
                      reason: availability.reason ?? "Unavailable",
                    }),
                  ),
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          ),
        ),
      );

    /**
     * The heaviest thing this server does: `open`/`resume` is where an agent
     * CLI is actually spawned or an SDK handle established. It is also the
     * likeliest to fail — a CLI that is not installed, an expired login, a cwd
     * that vanished — and the failure reaches the user as a session that "does
     * nothing".
     *
     * The native span correlates logs emitted during each acquisition. Which
     * session and harness come from the caller's `inSession`; the harness's own
     * id is attached after the adapter answers because it does not exist before
     * then — it is what a `claude --resume` command would take.
     */
    const acquireOpen = (
      harnessAgentId: HarnessAgentId,
      input: CreateSessionInput,
    ): AcquireRuntime =>
      checkAvailable(harnessAgentId).pipe(
        Effect.flatMap((adapter) => adapter.open(input)),
        Effect.tap((runtime) => Effect.annotateCurrentSpan("harnessSessionId", runtime.sessionId)),
        Effect.withSpan("harness.open"),
      );

    const acquireResume = (input: ResumeManagedSessionInput): AcquireRuntime =>
      checkAvailable(input.harnessAgentId).pipe(
        Effect.flatMap((adapter) => adapter.resume({ sessionId: input.sessionId, cwd: input.cwd })),
        Effect.tap((runtime) => Effect.annotateCurrentSpan("harnessSessionId", runtime.sessionId)),
        Effect.withSpan("harness.resume"),
      );

    /** Acquire through a session, retrying against a fresh one when the session
     * we asked was released out from under us — `sessionFor` is what waits for
     * that release to finish, so the retry can never overlap it. */
    const acquireVia = (
      ref: SessionRef,
      acquire: AcquireRuntime,
    ): Effect.Effect<HarnessAgentRuntime, ResumeSessionError> =>
      sessionFor(ref).pipe(
        Effect.flatMap((session) => session.ensureRuntime(acquire)),
        Effect.flatMap((runtime) => (runtime ? Effect.succeed(runtime) : acquireVia(ref, acquire))),
      );

    const peek = (ref: SessionRef): Effect.Effect<HarnessAgentRuntime | undefined> =>
      withSession<HarnessAgentRuntime | undefined>(
        ref,
        (session) => session.peekRuntime,
        undefined,
      );

    // The session stays in the table, marked closing, until its runtime is
    // gone: removing it first would let a concurrent write build a second
    // session for the same ref and resume it alongside the one still dying.
    const close = (ref: SessionRef): Effect.Effect<void> =>
      sessionTableLock
        .withPermit(
          Ref.modify(
            sessions,
            (current): readonly [CloseStep, ReadonlyMap<string, SessionEntry>] => {
              const entry = current.get(ref.sessionId);
              if (!entry) return [{ _tag: "Done" }, current];
              if (entry._tag === "Closing") return [{ _tag: "Await", done: entry.done }, current];
              const done = Deferred.makeUnsafe<void>();
              return [
                { _tag: "Release", session: entry.session, done },
                new Map(current).set(ref.sessionId, {
                  _tag: "Closing",
                  done,
                  streamId: entry.session.streamId,
                }),
              ];
            },
          ),
        )
        .pipe(
          Effect.flatMap((step) => {
            if (step._tag === "Done") return Effect.void;
            if (step._tag === "Await") return Deferred.await(step.done);
            return advanceStreamEpoch(ref).pipe(
              Effect.andThen(step.session.releaseRuntime),
              Effect.ensuring(
                Ref.update(sessions, (current) => {
                  const entry = current.get(ref.sessionId);
                  if (entry?._tag !== "Closing" || entry.done !== step.done) return current;
                  const next = new Map(current);
                  next.delete(ref.sessionId);
                  return next;
                }).pipe(Effect.andThen(Deferred.succeed(step.done, undefined))),
              ),
            );
          }),
        );

    const snapshot = (ref: SessionRef): Effect.Effect<SessionRuntimeSnapshot> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const entry = current.get(ref.sessionId);
          if (entry?._tag === "Live") return entry.session.snapshot;
          if (entry?._tag === "Closing") {
            return Effect.succeed(toSnapshot(ref, entry.streamId, initialSessionState));
          }
          return streamIdFor(ref).pipe(
            Effect.map((streamId) => toSnapshot(ref, streamId, initialSessionState)),
          );
        }),
      );

    yield* Scope.addFinalizer(
      ownerScope,
      Ref.get(sessions).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(
            Array.from(current.values()).filter((entry) => entry._tag === "Live"),
            (entry) => entry.session.releaseRuntime,
            { concurrency: "unbounded", discard: true },
          ),
        ),
      ),
    );

    return {
      open: (harnessAgentId, input, config, ref) =>
        // The create-time choice becomes the session's config before anything
        // is opened, so seeding on acquisition is the only path that applies
        // it — including on every runtime the session takes after this one.
        sessionFor(ref)
          .pipe(
            Effect.flatMap((session) => session.setConfig(config)),
            // Nothing is running yet, so recording the choice cannot fail.
            Effect.orDie,
            Effect.andThen(acquireVia(ref, acquireOpen(harnessAgentId, input))),
          )
          .pipe(
            // `AcquireRuntime` carries the resume union; the two members only a
            // resume can raise are unreachable here, so a sighting is an adapter
            // misbehaving and folds into AgentOpenError.
            Effect.mapError(
              (error): CreateSessionError =>
                error instanceof SessionNotResumable || error instanceof HarnessSessionNotFound
                  ? new AgentOpenError({ harnessAgentId, cause: error })
                  : error,
            ),
          ),
      ensureRuntime: (input, ref) => acquireVia(ref, acquireResume(input)),
      get: (ref) =>
        peek(ref).pipe(
          Effect.flatMap((runtime) =>
            runtime
              ? Effect.succeed(runtime)
              : Effect.fail(new HarnessSessionNotFound({ sessionId: ref.sessionId })),
          ),
        ),
      peek,
      setConfig: (ref, patch) =>
        sessionFor(ref).pipe(Effect.flatMap((session) => session.setConfig(patch))),
      close,
      status: (ref) => withSession(ref, (session) => session.status, toStatus(initialSessionState)),
      snapshot,
      liveStatus: (ref) =>
        withSession<SessionStatus | undefined>(ref, (session) => session.status, undefined),
      emit: (ref, body) => sessionFor(ref).pipe(Effect.flatMap((session) => session.emit(body))),
    } satisfies HarnessAgentSessionManagerShape;
  });

export const HarnessAgentSessionManagerLayer = Layer.effect(
  HarnessAgentSessionManager,
  Effect.gen(function* () {
    const registry = yield* HarnessAgentRegistry;
    const bus = yield* EventBus;
    const recovery = yield* SessionRecoveryStore;
    return yield* makeHarnessAgentSessionManager(registry, bus, (ref, streamId, eventBus) =>
      makeHarnessAgentSession(ref, streamId, eventBus, (eventRef, body) =>
        recovery.beforePublish(eventRef, body).pipe(Effect.orDie),
      ),
    );
  }),
);
