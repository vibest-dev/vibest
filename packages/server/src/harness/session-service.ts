import type {
  AgentResponse,
  HarnessAgentId,
  PermissionMode,
  PromptInput,
  ReasoningEffort,
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
  ResumeSessionError,
  SessionClosed,
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
import { inSession } from "./session-identity";
import type { SessionConfig } from "./session-io";
import type { HarnessAgentSessionManagerShape } from "./session-manager";
import { HarnessAgentSessionManager } from "./session-manager";
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
  /**
   * Set a session title by hand. The title is ours to own (see {@link deriveTitle}),
   * so this is a plain metadata write — the harness is never told, and a
   * user-chosen title survives every later prompt because
   * `readAndStampTitleFromFirstPrompt` only fills a record that has none.
   */
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
    | AgentOperationError
  >;
  /**
   * Stop the active turn. A session with nothing running succeeds without
   * doing anything: after a restart the turn the user is trying to stop died
   * with the process, so "stopped" is the truth and starting an agent in order
   * to interrupt it would be absurd.
   */
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
  readonly getStatus: (ref: SessionRef) => Effect.Effect<SessionStatus>;
  readonly getSnapshot: (ref: SessionRef) => Effect.Effect<SessionRuntimeSnapshot>;
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
  /** Mints a session id; RNG failure is a defect, so the effect never fails. */
  readonly newSessionId: Effect.Effect<string>;
}): HarnessAgentSessionServiceShape => {
  const { manager, registry, repo, bus, newSessionId } = deps;

  // Metadata updates are read-modify-write operations over one JSON record.
  // Serialize each session independently so two fields changed at once cannot
  // overwrite each other from stale snapshots, while a slow harness shutdown
  // for one session never stalls metadata work for every other session. Locks
  // stay keyed for this service's lifetime: retaining one tiny semaphore per
  // touched session avoids replacing a lock while delete waiters still hold it.
  const metadataMutationLocks = new Map<string, ReturnType<typeof Semaphore.makeUnsafe>>();
  const withMetadataMutation = <A, E, R>(
    ref: SessionRef,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    const key = `${ref.projectId}\0${ref.sessionId}`;
    const lock = metadataMutationLocks.get(key) ?? Semaphore.makeUnsafe(1);
    metadataMutationLocks.set(key, lock);
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
  // title write must never block the prompt itself. Re-read while holding the
  // metadata gate so a concurrent manual rename always wins rather than being
  // overwritten from the prompt's stale snapshot. On a real write we publish
  // `session.updated` before releasing the gate, preserving write/event order.
  const readAndStampTitleFromFirstPrompt = (ref: SessionRef, parts: PromptInput["parts"]) =>
    withMetadataMutation(
      ref,
      readChecked(ref).pipe(
        Effect.flatMap((metadata) => {
          if (metadata.title !== undefined) return Effect.succeed(metadata);
          const title = deriveTitle(parts);
          if (title === undefined) return Effect.succeed(metadata);
          const updated = { ...metadata, title };
          return repo.write(updated).pipe(
            Effect.andThen(bus.publish({ ref, type: "session.updated", title })),
            Effect.as(updated),
            Effect.catchTag("StoreWriteError", () => Effect.succeed(metadata)),
          );
        }),
      ),
    );

  /**
   * The lifecycle boundaries, at `info` — a session appearing, going away, or
   * being put aside. There are only a few dozen in a working day, so they sit
   * at a level that shows by default: read on their own they are the story of
   * what was worked on and when.
   *
   * Identity comes from the method's own `inSession`, so what is named here is
   * only what this particular boundary adds.
   *
   * Deliberately after the operation, never before: a line saying a session was
   * deleted, written before the delete could fail, is worse than no line.
   */
  const logLifecycle = (event: string, message: string, extra: Record<string, unknown> = {}) =>
    Effect.logInfo(message).pipe(Effect.annotateLogs({ event, ...extra }));

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
                Effect.andThen(
                  logLifecycle("session.created", "session created", {
                    cwd,
                    harnessSessionId: session.sessionId,
                  }),
                ),
                Effect.as(ref),
              );
            }),
            inSession(ref),
          );
        }),
      ),

    prepare: (ref, cwd) =>
      withMetadataMutation(
        ref,
        readChecked(ref).pipe(
          Effect.flatMap((metadata) => {
            if (metadata.cwd === cwd) return Effect.succeed(metadata);
            const updated = { ...metadata, cwd };
            return repo.write(updated).pipe(Effect.as(updated));
          }),
        ),
      ).pipe(
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
        inSession(ref),
      ),

    close: (ref) =>
      resolveHarnessSessionId(ref).pipe(
        Effect.andThen(manager.close(ref)),
        Effect.andThen(bus.closeSession(ref, "session_closed")),
        Effect.andThen(logLifecycle("session.closed", "session closed")),
        inSession(ref),
      ),

    delete: (ref) =>
      withMetadataMutation(
        ref,
        readChecked(ref).pipe(
          Effect.andThen(manager.close(ref)),
          Effect.andThen(bus.closeSession(ref, "session_deleted")),
          Effect.andThen(repo.remove(ref.projectId, ref.sessionId)),
          Effect.andThen(bus.publish({ ref, type: "session.deleted" })),
          // The one line that outlives what it describes: the metadata is gone,
          // so this is all that is left to say the session ever existed.
          Effect.andThen(logLifecycle("session.deleted", "session deleted")),
        ),
      ).pipe(inSession(ref)),

    rename: (ref, title) =>
      withMetadataMutation(
        ref,
        readChecked(ref).pipe(
          Effect.flatMap((metadata) =>
            // Persist before announcing: a rename every client has applied but
            // no record carries would come back on the next list load. A no-op
            // rename writes and publishes nothing.
            metadata.title === title
              ? Effect.void
              : repo
                  .write({ ...metadata, title })
                  .pipe(Effect.andThen(bus.publish({ ref, type: "session.renamed", title }))),
          ),
        ),
      ).pipe(inSession(ref)),

    archive: (ref, archived) =>
      withMetadataMutation(
        ref,
        readChecked(ref).pipe(
          Effect.flatMap((metadata) => {
            const changed = (metadata.archived ?? false) !== archived;
            const persist = changed ? repo.write({ ...metadata, archived }) : Effect.void;
            // Archive is also a lifecycle boundary: persist first so a failed
            // metadata write never kills live work. Restore stays cold until open.
            const close = archived
              ? manager.close(ref).pipe(Effect.andThen(bus.closeSession(ref, "session_closed")))
              : Effect.void;
            const publish = changed
              ? bus.publish({ ref, type: "session.archived", archived }).pipe(
                  Effect.andThen(
                    logLifecycle("session.archived", "session archive state changed", {
                      archived,
                    }),
                  ),
                )
              : Effect.void;
            return persist.pipe(Effect.andThen(close), Effect.andThen(publish));
          }),
        ),
      ).pipe(inSession(ref)),

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
        inSession(ref),
      ),

    prompt: (input) =>
      Effect.gen(function* () {
        const userInput = yield* toUserInput(input.parts);
        // The first prompt names the session before it reaches the harness.
        const metadata = yield* readAndStampTitleFromFirstPrompt(input.ref, input.parts);
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
      }).pipe(inSession(input.ref)),

    interrupt: (ref) =>
      readChecked(ref).pipe(
        Effect.andThen(manager.peek(ref)),
        Effect.flatMap((runtime) => runtime?.interrupt ?? Effect.void),
        inSession(ref),
      ),

    setModel: (ref, model) =>
      readChecked(ref).pipe(Effect.andThen(manager.setConfig(ref, { model })), inSession(ref)),

    setReasoningEffort: (ref, reasoningEffort) =>
      readChecked(ref).pipe(
        Effect.andThen(manager.setConfig(ref, { reasoningEffort })),
        inSession(ref),
      ),

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
        inSession(ref),
      ),

    respondToAgentRequest: (ref, requestId, response) =>
      readChecked(ref).pipe(
        Effect.andThen(manager.peek(ref)),
        Effect.flatMap((runtime) =>
          runtime
            ? runtime.respondToAgentRequest(requestId, response)
            : Effect.fail(new AgentRequestUnavailable({ sessionId: ref.sessionId, requestId })),
        ),
        inSession(ref),
      ),

    // The one operation still gated on something running: what a harness can
    // do is negotiated with the live agent, and there is nothing to ask when
    // no agent is there.
    getCapabilities: (ref) =>
      readChecked(ref).pipe(
        Effect.andThen(manager.get(ref)),
        Effect.flatMap((runtime) => runtime.getCapabilities),
        inSession(ref),
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
        inSession(ref),
      ),

    // Not wrapped: both are pure reads of in-memory state, and `getSnapshot` is
    // on the subscribe path, which runs per reconnect.
    getStatus: (ref) => manager.status(ref),
    getSnapshot: (ref) => manager.snapshot(ref),

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
  | Paths
  | Crypto.Crypto
  | FileSystem.FileSystem
> = Layer.effect(
  HarnessAgentSessionService,
  Effect.gen(function* () {
    const manager = yield* HarnessAgentSessionManager;
    const registry = yield* HarnessAgentRegistry;
    const bus = yield* EventBus;
    const paths = yield* Paths;
    const crypto = yield* Crypto.Crypto;
    const repo = yield* makeHarnessAgentSessionRepository(paths.sessionsDir);
    return makeHarnessAgentSessionService({
      manager,
      registry,
      repo,
      bus,
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
