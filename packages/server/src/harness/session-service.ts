import type {
  AgentResponse,
  HarnessAgentId,
  PermissionMode,
  PromptInput,
  ReasoningEffort,
  SteerInput,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionStatus,
  SessionSummary,
} from "@vibest/contract";
import type { UIMessage } from "ai";
import { Context, Crypto, Effect, FileSystem, Layer, Semaphore } from "effect";

import { Paths } from "../config/paths";
import {
  type SessionNotFound,
  SessionRefMismatch,
  type SessionRefNotFound,
  type StoreReadError,
  type StoreWriteError,
  UnsupportedPromptPart,
} from "../errors";
import { EventBus, type EventBusShape } from "../events/event-bus";
import type { Session } from "../types";
import type { PromptReceipt, SessionCapabilities, SessionInfoResult, UserInput } from "./adapter";
import type {
  AgentOperationError,
  CreateSessionError,
  HarnessAgentNotFound,
  HarnessSessionNotFound,
  RecoveryRequired,
  ResumeSessionError,
  SessionClosed,
  StaleRecovery,
  TurnAlreadyRunning,
} from "./errors";
import {
  AgentRequestUnavailable,
  CapabilityUnsupported,
  PermissionModeUnsupported,
  SessionNotResumable,
} from "./errors";
import type { HarnessAgentRegistryShape } from "./registry";
import { HarnessAgentRegistry } from "./registry";
import type { SessionConfig } from "./session-io";
import type { HarnessAgentSessionManagerShape } from "./session-manager";
import { HarnessAgentSessionManager } from "./session-manager";
import { SessionRecoveryStore, type SessionRecoveryStoreShape } from "./session-recovery";
import {
  type HarnessAgentSessionRepositoryShape,
  makeHarnessAgentSessionRepository,
} from "./session-repository";

/**
 * The outward session service — everything the app's session control-plane
 * goes through, addressed by {@link SessionRef}. It owns what the layers below
 * must stay ignorant of: generating the server `sessionId`, persisting
 * {@link Session} metadata (via its private repository), translating a
 * `SessionRef` to the agent-native `harnessSessionId`, validating wire
 * vocabulary (permission modes, prompt parts), and publishing the collection
 * events that announce lifecycle changes. Live state — sessions and the
 * runtimes they hold — belongs to {@link HarnessAgentSessionManager}; this
 * service holds none. The router above contributes only the resolved workspace
 * path (`cwd`): a projectId is never accepted as a path.
 */

/**
 * A session's title, derived from its first prompt's text — the crude but
 * self-owned placeholder we show until (if ever) something better replaces it.
 * Collapses whitespace and clamps length; no text part (e.g. inspector-only)
 * yields no title.
 */
const MAX_TITLE_CHARS = 60;
const deriveTitle = (parts: PromptInput["parts"]): string | undefined => {
  const text = parts.find((part) => part.type === "text")?.text.trim();
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, " ");
  return collapsed.length > MAX_TITLE_CHARS ? collapsed.slice(0, MAX_TITLE_CHARS) : collapsed;
};

/** Wire prompt parts → HarnessAgent UserInput; `file` parts are rejected, never dropped. */
const toUserInput = (
  parts: PromptInput["parts"],
): Effect.Effect<UserInput, UnsupportedPromptPart> =>
  Effect.forEach(parts, (part) =>
    part.type === "file"
      ? Effect.fail(new UnsupportedPromptPart({ kind: "file" }))
      : Effect.succeed(part),
  ).pipe(Effect.map((userParts) => ({ parts: userParts })));

export type HarnessAgentSessionServiceShape = {
  readonly create: (
    projectId: string,
    harnessAgentId: HarnessAgentId,
    cwd: string,
    config?: SessionConfig,
  ) => Effect.Effect<SessionRef, CreateSessionError | StoreWriteError>;
  /**
   * What a client does when it opens a session: prove the ref is real and
   * self-consistent, record the project's working directory on it, and confirm
   * the harness still has the native session behind it. Deliberately starts
   * nothing — a session becomes live when someone prompts it, not when someone
   * looks at it, which is why a reconnecting client no longer revives every
   * agent it had open.
   *
   * The cwd backfill is the reason this is a write: `cwd` is a floor field we
   * own, and this is the only path that learns the project's path for a
   * session created before we stored one.
   */
  readonly prepare: (
    ref: SessionRef,
    cwd: string,
  ) => Effect.Effect<
    void,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | StoreWriteError
    | HarnessAgentNotFound
    | SessionNotResumable
    | AgentOperationError
  >;
  readonly close: (
    ref: SessionRef,
  ) => Effect.Effect<void, SessionNotFound | SessionRefMismatch | StoreReadError>;
  /** Close the native session, discard its live state, and delete its metadata. */
  readonly delete: (
    ref: SessionRef,
  ) => Effect.Effect<void, SessionNotFound | SessionRefMismatch | StoreReadError | StoreWriteError>;
  readonly rename: (
    ref: SessionRef,
    title: string,
  ) => Effect.Effect<void, SessionNotFound | SessionRefMismatch | StoreReadError | StoreWriteError>;
  readonly archive: (
    ref: SessionRef,
    archived: boolean,
  ) => Effect.Effect<void, SessionNotFound | SessionRefMismatch | StoreReadError | StoreWriteError>;
  readonly list: (
    projectId: string,
    archived: boolean,
  ) => Effect.Effect<ReadonlyArray<SessionSummary>, StoreReadError>;
  /**
   * The session's native history as final-form UIMessages, then trimmed of the
   * active turn's tail so history never duplicates the live stream.
   *
   * How it is read is the harness's own policy, expressed structurally rather
   * than by a flag: an adapter that can read a transcript cold does so and
   * costs nothing, otherwise the session's runtime answers — acquired for the
   * purpose if it has none, which for pi is the only way its history exists at
   * all. A harness that offers neither read fails
   * {@link CapabilityUnsupported}.
   */
  readonly getMessages: (
    ref: SessionRef,
    cwd: string,
  ) => Effect.Effect<
    ReadonlyArray<UIMessage>,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | ResumeSessionError
    | CapabilityUnsupported
    | SessionClosed
    | AgentOperationError
  >;
  /**
   * Submit a user message. The one operation allowed to start an agent: a
   * session with no runtime acquires exactly one here, single-flighted, so
   * concurrent prompts share it.
   */
  readonly prompt: (
    input: PromptInput,
  ) => Effect.Effect<
    PromptReceipt,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | UnsupportedPromptPart
    | ResumeSessionError
    | SessionClosed
    | TurnAlreadyRunning
    | RecoveryRequired
    | AgentOperationError
  >;
  readonly acknowledgeRecovery: (
    ref: SessionRef,
    recoveryId: string,
  ) => Effect.Effect<
    void,
    SessionNotFound | SessionRefMismatch | StoreReadError | StoreWriteError | StaleRecovery
  >;
  /**
   * Stop the active turn. A session with nothing running succeeds without
   * doing anything: after a restart the turn the user is trying to stop died
   * with the process, so "stopped" is the truth and starting an agent in order
   * to interrupt it would be absurd.
   */
  readonly steer: (
    input: SteerInput,
  ) => Effect.Effect<
    void,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | UnsupportedPromptPart
    | HarnessAgentNotFound
    | HarnessSessionNotFound
    | SessionClosed
    | TurnAlreadyRunning
    | AgentOperationError
  >;
  readonly interrupt: (
    ref: SessionRef,
  ) => Effect.Effect<
    void,
    SessionNotFound | SessionRefMismatch | StoreReadError | SessionClosed | AgentOperationError
  >;
  // Session-scoped config setters. They record the choice on the session and
  // push it to the runtime only if one is live: picking a model for a session
  // that isn't running succeeds, and the choice is seeded onto whatever runtime
  // the session acquires next. `model` is the provider-local model id — the RPC
  // boundary unpacked and validated the providerId/modelId pair already.
  readonly setModel: (
    ref: SessionRef,
    model: string,
  ) => Effect.Effect<
    void,
    SessionNotFound | SessionRefMismatch | StoreReadError | SessionClosed | AgentOperationError
  >;
  readonly setReasoningEffort: (
    ref: SessionRef,
    reasoningEffort: ReasoningEffort,
  ) => Effect.Effect<
    void,
    SessionNotFound | SessionRefMismatch | StoreReadError | SessionClosed | AgentOperationError
  >;
  readonly setPermissionMode: (
    ref: SessionRef,
    permissionMode: PermissionMode,
  ) => Effect.Effect<
    void,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | PermissionModeUnsupported
    | SessionClosed
    | AgentOperationError
  >;
  /**
   * Answer a permission or question request. With nothing running there is
   * nobody left to hear it — the request died with the process that raised it —
   * so this is {@link AgentRequestUnavailable}, the same answer a request
   * someone else already resolved gets.
   */
  readonly respondToAgentRequest: (
    ref: SessionRef,
    requestId: string,
    response: AgentResponse,
  ) => Effect.Effect<
    void,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | AgentRequestUnavailable
    | AgentOperationError
  >;
  readonly getCapabilities: (
    ref: SessionRef,
  ) => Effect.Effect<
    SessionCapabilities,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | HarnessSessionNotFound
    | CapabilityUnsupported
    | AgentOperationError
  >;
  /**
   * Best-effort display info (title, recency, existence) for a persisted
   * session, without opening it — a cold read straight off the adapter.
   */
  readonly getSessionInfo: (
    ref: SessionRef,
  ) => Effect.Effect<
    SessionInfoResult,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | HarnessAgentNotFound
    | AgentOperationError
  >;
  /**
   * What a session is doing. Total: a persisted session with nothing live in
   * memory reads as idle, so attaching after a restart neither fails nor
   * starts anything.
   */
  readonly getStatus: (ref: SessionRef) => Effect.Effect<SessionStatus, StoreReadError>;
  readonly getSnapshot: (ref: SessionRef) => Effect.Effect<SessionRuntimeSnapshot, StoreReadError>;
  /** Reverse a bare sessionId back into its full SessionRef. */
  readonly resolveRef: (
    sessionId: string,
  ) => Effect.Effect<SessionRef, StoreReadError | SessionRefNotFound>;
};

export class HarnessAgentSessionService extends Context.Service<
  HarnessAgentSessionService,
  HarnessAgentSessionServiceShape
>()("HarnessAgentSessionService") {}

export const makeHarnessAgentSessionService = (deps: {
  readonly manager: HarnessAgentSessionManagerShape;
  readonly registry: HarnessAgentRegistryShape;
  readonly repo: HarnessAgentSessionRepositoryShape;
  readonly bus: EventBusShape;
  readonly recovery: SessionRecoveryStoreShape;
  /** Mints a session id; RNG failure is a defect, so the effect never fails. */
  readonly newSessionId: Effect.Effect<string>;
}): HarnessAgentSessionServiceShape => {
  const { manager, registry, repo, bus, recovery, newSessionId } = deps;
  const lifecycleLocks = new Map<string, ReturnType<typeof Semaphore.makeUnsafe>>();
  const lifecycleKey = (ref: SessionRef) =>
    JSON.stringify([ref.projectId, ref.harnessAgentId, ref.sessionId]);
  const withLifecycleWrite = <A, E, R>(
    ref: SessionRef,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    const key = lifecycleKey(ref);
    let lock = lifecycleLocks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      lifecycleLocks.set(key, lock);
    }
    return lock.withPermit(effect);
  };

  // The permission mode is our closed vocabulary, so membership in the
  // harness's declared subset is checked here — the boundary between the
  // wire and the adapters — and rejected loudly. Opaque values (model) get
  // no such check: their lists go stale legitimately, so adapters treat
  // misses as best-effort instead.
  const checkPermissionMode = (harnessAgentId: HarnessAgentId, mode: PermissionMode | undefined) =>
    mode === undefined
      ? Effect.void
      : registry
          .get(harnessAgentId)
          .pipe(
            Effect.flatMap((adapter) =>
              adapter.permissionModes.includes(mode)
                ? Effect.void
                : Effect.fail(new PermissionModeUnsupported({ harnessAgentId, mode })),
            ),
          );

  /**
   * The two ways a harness can produce history. Which one applies is structural
   * — what the adapter and the runtime implement — not a flag: a cold read
   * answers off disk or a shared server, and only a harness whose history
   * *lives* in its child process is worth a runtime for. `ensureRuntime` is
   * free when the session already holds one, so asking for it costs a process
   * only when there is none.
   *
   * The warm branch is also where a harness offering neither read is found out,
   * one acquisition too late; there is no cheaper way to learn it, and no such
   * harness exists today.
   */
  const readHistory = (
    ref: SessionRef,
    harnessSessionId: string,
    cwd: string,
  ): Effect.Effect<
    ReadonlyArray<UIMessage>,
    ResumeSessionError | CapabilityUnsupported | SessionClosed | AgentOperationError
  > =>
    registry.get(ref.harnessAgentId).pipe(
      Effect.flatMap((adapter) => {
        const cold = adapter.getMessages;
        if (cold) return cold(harnessSessionId, cwd);
        return manager
          .ensureRuntime(
            { sessionId: harnessSessionId, harnessAgentId: ref.harnessAgentId, cwd },
            ref,
          )
          .pipe(
            Effect.flatMap(
              (
                runtime,
              ): Effect.Effect<
                ReadonlyArray<UIMessage>,
                CapabilityUnsupported | SessionClosed | AgentOperationError
              > =>
                runtime.getMessages ??
                Effect.fail(
                  new CapabilityUnsupported({
                    harnessAgentId: ref.harnessAgentId,
                    capability: "getMessages",
                  }),
                ),
            ),
          );
      }),
    );

  const readChecked = (ref: SessionRef) =>
    repo
      .read(ref.projectId, ref.sessionId)
      .pipe(
        Effect.flatMap((metadata) =>
          metadata.harnessAgentId === ref.harnessAgentId
            ? Effect.succeed(metadata)
            : Effect.fail(
                new SessionRefMismatch({ projectId: ref.projectId, sessionId: ref.sessionId }),
              ),
        ),
      );

  const resolveHarnessSessionId = (ref: SessionRef) =>
    readChecked(ref).pipe(Effect.map((metadata) => metadata.harnessSessionId));

  // The repo read stays: it is what validates the ref (SessionNotFound /
  // SessionRefMismatch) before the manager is asked for anything. It just no
  // longer supplies an address — the manager is keyed by the ref itself.
  // The first prompt establishes the session title. Best-effort: a failed
  // title write must never block the prompt itself. A record that already has
  // a title (any later prompt) is left alone. On a real write we publish
  // `session.updated` so every client patches the row — the specific event
  // that reconciles the optimistic title, in place of any timer.
  const stampTitleFromFirstPrompt = (metadata: Session, parts: PromptInput["parts"]) => {
    if (metadata.title !== undefined) return Effect.void;
    const title = deriveTitle(parts);
    if (title === undefined) return Effect.void;
    const ref: SessionRef = {
      projectId: metadata.projectId,
      harnessAgentId: metadata.harnessAgentId,
      sessionId: metadata.sessionId,
    };
    return repo.write({ ...metadata, title }).pipe(
      Effect.andThen(bus.publish({ ref, type: "session.updated", title })),
      Effect.catchTag("StoreWriteError", () => Effect.void),
    );
  };

  return {
    create: (projectId, harnessAgentId, cwd, config) =>
      checkPermissionMode(harnessAgentId, config?.permissionMode).pipe(
        Effect.andThen(newSessionId),
        Effect.flatMap((sessionId) => {
          const ref: SessionRef = { projectId, harnessAgentId, sessionId };
          return manager.open(harnessAgentId, { cwd }, config ?? {}, ref).pipe(
            Effect.flatMap((session) => {
              const metadata: Session = {
                sessionId,
                projectId,
                harnessAgentId,
                harnessSessionId: session.sessionId,
                createdAt: new Date().toISOString(),
                // Our own floor field: the session's working directory. Stored
                // so an imported/rehomed session stays self-contained and a
                // resume has cwd before it can call getSessionInfo.
                cwd,
                archived: false,
              };
              return repo.write(metadata).pipe(
                // A failed metadata write must not leak the native session.
                Effect.tapError(() => manager.close(ref)),
                Effect.andThen(bus.publish({ ref, type: "session.created" })),
                Effect.as(ref),
              );
            }),
          );
        }),
      ),

    prepare: (ref, cwd) =>
      readChecked(ref).pipe(
        Effect.tap((metadata) =>
          metadata.cwd === cwd ? Effect.void : repo.write({ ...metadata, cwd }),
        ),
        Effect.flatMap((metadata) =>
          registry
            .get(ref.harnessAgentId)
            .pipe(
              Effect.flatMap((adapter) => adapter.getSessionInfo(metadata.harnessSessionId, cwd)),
            ),
        ),
        // A harness that has forgotten the session says so cheaply, and saying
        // it now is the difference between a toast on open and a mystery when
        // the user finally sends a message. `unsupported` is not a verdict —
        // pi cannot answer this question at all.
        Effect.flatMap((info) =>
          info._tag === "missing"
            ? Effect.fail(new SessionNotResumable({ sessionId: ref.sessionId }))
            : Effect.void,
        ),
      ),

    close: (ref) =>
      withLifecycleWrite(
        ref,
        resolveHarnessSessionId(ref).pipe(
          Effect.andThen(manager.close(ref)),
          Effect.andThen(recovery.clear(ref).pipe(Effect.orDie)),
          Effect.andThen(bus.closeSession(ref, "session_closed")),
        ),
      ),

    delete: (ref) =>
      withLifecycleWrite(
        ref,
        readChecked(ref).pipe(
          Effect.andThen(manager.close(ref)),
          Effect.andThen(bus.closeSession(ref, "session_deleted")),
          Effect.andThen(recovery.clear(ref)),
          Effect.andThen(repo.remove(ref.projectId, ref.sessionId)),
          Effect.andThen(bus.publish({ ref, type: "session.deleted" })),
        ),
      ),

    rename: (ref, title) =>
      readChecked(ref).pipe(
        Effect.flatMap((metadata) =>
          metadata.title === title
            ? Effect.void
            : repo
                .write({ ...metadata, title })
                .pipe(Effect.andThen(bus.publish({ ref, type: "session.renamed", title }))),
        ),
      ),

    archive: (ref, archived) =>
      withLifecycleWrite(
        ref,
        readChecked(ref).pipe(
          Effect.flatMap((metadata) => {
            const changed = (metadata.archived ?? false) !== archived;
            const persist = changed ? repo.write({ ...metadata, archived }) : Effect.void;
            // Archive is also a lifecycle boundary: persist first so a failed
            // metadata write never kills live work. Restore stays cold until open.
            const close = archived
              ? manager
                  .close(ref)
                  .pipe(
                    Effect.andThen(bus.closeSession(ref, "session_closed")),
                    Effect.andThen(recovery.clear(ref)),
                  )
              : Effect.void;
            const publish = changed
              ? bus.publish({ ref, type: "session.archived", archived })
              : Effect.void;
            return persist.pipe(Effect.andThen(close), Effect.andThen(publish));
          }),
        ),
      ),

    // A pure read of our own records — display data is self-owned (title from
    // the first prompt, createdAt/cwd from create), so no per-session backend
    // lookup. `status` is the one overlay, and it comes from the manager's
    // live sessions, not the harness index: a row with no status is one this
    // process has not touched, which is different from one sitting idle.
    list: (projectId, archived) =>
      repo.list(projectId).pipe(
        Effect.map((sessions) =>
          sessions.filter((metadata) => (metadata.archived ?? false) === archived),
        ),
        Effect.flatMap((sessions) =>
          Effect.forEach(sessions, (metadata) =>
            manager
              .liveStatus({
                projectId: metadata.projectId,
                harnessAgentId: metadata.harnessAgentId,
                sessionId: metadata.sessionId,
              })
              .pipe(
                Effect.map(
                  (status) =>
                    ({
                      projectId: metadata.projectId,
                      harnessAgentId: metadata.harnessAgentId,
                      sessionId: metadata.sessionId,
                      archived: metadata.archived ?? false,
                      createdAt: metadata.createdAt,
                      // We own the record, so the session exists as far as we
                      // know; a resume (or a getMessages read) proves
                      // otherwise reactively.
                      historyAvailable: metadata.historyAvailable ?? true,
                      ...(metadata.title !== undefined ? { title: metadata.title } : {}),
                      ...(metadata.updatedAt !== undefined
                        ? { updatedAt: metadata.updatedAt }
                        : {}),
                      ...(status !== undefined ? { status } : {}),
                    }) satisfies SessionSummary,
                ),
              ),
          ),
        ),
      ),

    getMessages: (ref, cwd) =>
      readChecked(ref).pipe(
        Effect.flatMap((metadata) =>
          readHistory(ref, metadata.harnessSessionId, cwd).pipe(
            Effect.flatMap((messages) =>
              // History includes the in-flight turn's user entry; the live
              // stream replays that turn, so drop the last user segment while
              // a turn runs. A finished turn's buffer is retained
              // (complete: true) until the next turn starts — that is
              // settled history, not an in-flight turn, so it must not trim.
              // An untouched session reads as idle, so it never trims.
              // `activeTurnId` is set exactly while a turn is running, which is
              // the whole question — no need to copy the turn's chunks to ask.
              manager.status(ref).pipe(
                Effect.map((status) => {
                  if (status.activeTurnId === undefined) return messages;
                  for (let index = messages.length - 1; index >= 0; index -= 1) {
                    if (messages[index]?.role === "user") return messages.slice(0, index);
                  }
                  return messages;
                }),
              ),
            ),
          ),
        ),
      ),

    prompt: (input) =>
      withLifecycleWrite(
        input.ref,
        Effect.gen(function* () {
          const metadata = yield* readChecked(input.ref);
          yield* recovery.requireClear(input.ref);
          const userInput = yield* toUserInput(input.parts);
          // The first prompt names the session before it reaches the harness.
          yield* stampTitleFromFirstPrompt(metadata, input.parts);
          const messageId = input.messageId ?? (yield* newSessionId);

          // Broadcast the received prompt *before* the harness call so it always
          // precedes the turn's own events in seq order. If the harness then
          // rejects the prompt, `session.prompt.rejected` compensates — clients
          // drop the phantom user message and the runtime clears the retained
          // activePrompt.
          // A user message is the one thing that justifies starting an agent, so
          // this is where a runtime is acquired if the session has none — after
          // the submitted event, so a failed acquisition is compensated by the
          // same `prompt.rejected` that a harness-side rejection uses.
          return yield* Effect.uninterruptible(
            manager
              .emit(input.ref, {
                type: "session.prompt.submitted",
                messageId,
                parts: input.parts,
              })
              .pipe(
                Effect.andThen(
                  manager.ensureRuntime(
                    {
                      sessionId: metadata.harnessSessionId,
                      harnessAgentId: input.ref.harnessAgentId,
                      ...(metadata.cwd !== undefined ? { cwd: metadata.cwd } : {}),
                    },
                    input.ref,
                  ),
                ),
                Effect.flatMap((runtime) => runtime.prompt(userInput)),
                // Acquisition and prompt rejection are the same visible outcome:
                // both must compensate the submitted candidate retained above.
                Effect.tapError((promptError) =>
                  manager.emit(input.ref, {
                    type: "session.prompt.rejected",
                    messageId,
                    reason: promptError.message,
                  }),
                ),
                // Once submitted is visible, interruption must not leave the
                // candidate without a terminal correlation. Runtime prompt
                // receipts are short-lived; finish this emit before honoring a
                // disconnected caller's cancellation.
                Effect.tap((receipt) =>
                  manager.emit(input.ref, {
                    type: "session.prompt.accepted",
                    messageId,
                    turnId: receipt.turnId,
                  }),
                ),
              ),
          );
        }),
      ),

    acknowledgeRecovery: (ref, recoveryId) =>
      withLifecycleWrite(
        ref,
        readChecked(ref).pipe(
          Effect.andThen(
            Effect.uninterruptible(
              recovery
                .acknowledge(ref, recoveryId)
                .pipe(
                  Effect.andThen(
                    manager.emit(ref, { type: "session.recovery.acknowledged", recoveryId }),
                  ),
                ),
            ),
          ),
        ),
      ),

    steer: (input) =>
      Effect.gen(function* () {
        yield* readChecked(input.ref);
        const userInput = yield* toUserInput(input.parts);
        yield* Effect.uninterruptible(
          manager
            .emit(input.ref, {
              type: "session.prompt.submitted",
              messageId: input.messageId,
              parts: input.parts,
            })
            .pipe(
              Effect.andThen(manager.get(input.ref)),
              Effect.flatMap((runtime) => runtime.steer(input.expectedTurnId, userInput)),
              Effect.tapError((steerError) =>
                manager.emit(input.ref, {
                  type: "session.prompt.rejected",
                  messageId: input.messageId,
                  reason: steerError.message,
                }),
              ),
              Effect.tap(() =>
                manager.emit(input.ref, {
                  type: "session.prompt.accepted",
                  messageId: input.messageId,
                  turnId: input.expectedTurnId,
                }),
              ),
            ),
        );
      }),

    interrupt: (ref) =>
      readChecked(ref).pipe(
        Effect.andThen(manager.peek(ref)),
        Effect.flatMap((runtime) => runtime?.interrupt ?? Effect.void),
      ),

    setModel: (ref, model) =>
      readChecked(ref).pipe(Effect.andThen(manager.setConfig(ref, { model }))),

    setReasoningEffort: (ref, reasoningEffort) =>
      readChecked(ref).pipe(Effect.andThen(manager.setConfig(ref, { reasoningEffort }))),

    setPermissionMode: (ref, permissionMode) =>
      readChecked(ref).pipe(
        Effect.andThen(
          // The ref checked out, so its harness is one of ours by construction.
          checkPermissionMode(ref.harnessAgentId, permissionMode).pipe(
            Effect.catchTag("HarnessAgentNotFound", (cause) =>
              Effect.die(
                new Error(
                  `invariant: session '${ref.sessionId}' names an unregistered adapter '${ref.harnessAgentId}'`,
                  { cause },
                ),
              ),
            ),
          ),
        ),
        Effect.andThen(manager.setConfig(ref, { permissionMode })),
      ),

    respondToAgentRequest: (ref, requestId, response) =>
      readChecked(ref).pipe(
        Effect.andThen(manager.peek(ref)),
        Effect.flatMap((runtime) =>
          runtime
            ? runtime.respondToAgentRequest(requestId, response)
            : Effect.fail(new AgentRequestUnavailable({ sessionId: ref.sessionId, requestId })),
        ),
      ),

    getCapabilities: (ref) =>
      // The one operation still gated on something running: what a harness can
      // do is negotiated with the live agent, and there is nothing to ask when
      // no agent is there.
      readChecked(ref).pipe(
        Effect.andThen(manager.get(ref)),
        Effect.flatMap((runtime) => runtime.getCapabilities),
      ),

    getSessionInfo: (ref) =>
      readChecked(ref).pipe(
        Effect.flatMap((metadata) =>
          registry
            .get(metadata.harnessAgentId)
            .pipe(
              Effect.flatMap((adapter) =>
                adapter.getSessionInfo(metadata.harnessSessionId, metadata.cwd),
              ),
            ),
        ),
      ),

    getStatus: (ref) =>
      Effect.all([manager.status(ref), recovery.barrier(ref)]).pipe(
        Effect.map(([status, barrier]) =>
          barrier === null ? status : { phase: "recovery_required" as const },
        ),
      ),
    getSnapshot: (ref) =>
      Effect.all([manager.snapshot(ref), recovery.barrier(ref)]).pipe(
        Effect.map(([snapshot, barrier]) =>
          barrier === null
            ? snapshot
            : {
                ...snapshot,
                status: { phase: "recovery_required" as const },
                recovery: barrier,
                pendingRequests: [],
                activeTurn: null,
              },
        ),
      ),

    resolveRef: (sessionId) =>
      repo.findBySessionId(sessionId).pipe(
        Effect.map(
          (metadata): SessionRef => ({
            projectId: metadata.projectId,
            harnessAgentId: metadata.harnessAgentId,
            sessionId: metadata.sessionId,
          }),
        ),
      ),
  } satisfies HarnessAgentSessionServiceShape;
};

export const HarnessAgentSessionServiceLayer: Layer.Layer<
  HarnessAgentSessionService,
  never,
  | HarnessAgentSessionManager
  | HarnessAgentRegistry
  | EventBus
  | SessionRecoveryStore
  | Paths
  | Crypto.Crypto
  | FileSystem.FileSystem
> = Layer.effect(
  HarnessAgentSessionService,
  Effect.gen(function* () {
    const manager = yield* HarnessAgentSessionManager;
    const registry = yield* HarnessAgentRegistry;
    const bus = yield* EventBus;
    const recovery = yield* SessionRecoveryStore;
    const paths = yield* Paths;
    const crypto = yield* Crypto.Crypto;
    const repo = yield* makeHarnessAgentSessionRepository(paths.sessionsDir);
    return makeHarnessAgentSessionService({
      manager,
      registry,
      repo,
      bus,
      recovery,
      // A platform RNG that cannot produce a uuid is a defect, not a domain
      // failure — keep it out of the service's error channel. Tag-specific so
      // a future recoverable error on this channel stays typed instead of dying.
      newSessionId: crypto.randomUUIDv4.pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.die(new Error("invariant: platform RNG failed minting a session id", { cause })),
        ),
      ),
    });
  }),
);
