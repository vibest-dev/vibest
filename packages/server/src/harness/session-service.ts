import type {
  AgentResponse,
  HarnessAgentId,
  PermissionMode,
  PromptInput,
  ReasoningEffort,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEventBody,
  SessionStatus,
  SessionSummary,
} from "@vibest/contract";
import type { UIMessage } from "ai";
import { Context, Crypto, Effect, FileSystem, Layer } from "effect";

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
  AgentRequestUnavailable,
  CreateSessionError,
  HarnessAgentNotFound,
  HarnessSessionNotFound,
  ResumeSessionError,
  SessionClosed,
  TurnAlreadyRunning,
} from "./errors";
import { CapabilityUnsupported, PermissionModeUnsupported } from "./errors";
import type { HarnessAgentRegistryShape } from "./registry";
import { HarnessAgentRegistry } from "./registry";
import type { HarnessAgentSessionManagerShape } from "./session-manager";
import { HarnessAgentSessionManager } from "./session-manager";
import {
  type HarnessAgentSessionRepositoryShape,
  makeHarnessAgentSessionRepository,
} from "./session-repository";
import type { SessionNotActive } from "./session-runtime";

/**
 * The outward session service — everything the app's session control-plane
 * goes through, addressed by {@link SessionRef}. It owns what the layers below
 * must stay ignorant of: generating the server `sessionId`, persisting
 * {@link Session} metadata (via its private repository), translating a
 * `SessionRef` to the agent-native `harnessSessionId`, validating wire
 * vocabulary (permission modes, prompt parts), and publishing the collection
 * events that announce lifecycle changes. Live state — instances and
 * projections — belongs to {@link HarnessAgentSessionManager}; this service
 * holds none. The router above contributes only the resolved workspace path
 * (`cwd`): a projectId is never accepted as a path.
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
    config?: {
      readonly model?: string;
      readonly reasoningEffort?: ReasoningEffort;
      readonly permissionMode?: PermissionMode;
    },
  ) => Effect.Effect<SessionRef, CreateSessionError | StoreWriteError>;
  readonly resume: (
    ref: SessionRef,
    cwd: string,
  ) => Effect.Effect<
    void,
    SessionNotFound | SessionRefMismatch | StoreReadError | ResumeSessionError
  >;
  readonly close: (
    ref: SessionRef,
  ) => Effect.Effect<void, SessionNotFound | SessionRefMismatch | StoreReadError>;
  /** Close the native session, discard its projection, and delete its metadata. */
  readonly delete: (
    ref: SessionRef,
  ) => Effect.Effect<void, SessionNotFound | SessionRefMismatch | StoreReadError | StoreWriteError>;
  readonly rename: (
    ref: SessionRef,
    name: string,
  ) => Effect.Effect<void, SessionNotFound | SessionRefMismatch | StoreReadError>;
  readonly list: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<SessionSummary>, StoreReadError>;
  /**
   * The session's native history as final-form UIMessages. Ensures the
   * session is open (idempotent resume via the manager), reads through the
   * live instance's optional `getMessages` (absence = the harness has no
   * history read → {@link CapabilityUnsupported}), then trims the active
   * turn's tail so history never duplicates the live stream.
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
  readonly prompt: (
    input: PromptInput,
  ) => Effect.Effect<
    PromptReceipt,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | UnsupportedPromptPart
    | HarnessSessionNotFound
    | SessionClosed
    | TurnAlreadyRunning
    | AgentOperationError
  >;
  readonly interrupt: (
    ref: SessionRef,
  ) => Effect.Effect<
    void,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | HarnessSessionNotFound
    | SessionClosed
    | AgentOperationError
  >;
  // Session-scoped config setters. `model` is the provider-local model id —
  // the RPC boundary unpacked and validated the providerId/modelId pair already.
  readonly setModel: (
    ref: SessionRef,
    model: string,
  ) => Effect.Effect<
    void,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | HarnessSessionNotFound
    | SessionClosed
    | AgentOperationError
  >;
  readonly setReasoningEffort: (
    ref: SessionRef,
    reasoningEffort: ReasoningEffort,
  ) => Effect.Effect<
    void,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | HarnessSessionNotFound
    | SessionClosed
    | AgentOperationError
  >;
  readonly setPermissionMode: (
    ref: SessionRef,
    permissionMode: PermissionMode,
  ) => Effect.Effect<
    void,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | HarnessSessionNotFound
    | PermissionModeUnsupported
    | SessionClosed
    | AgentOperationError
  >;
  readonly respondToAgentRequest: (
    ref: SessionRef,
    requestId: string,
    response: AgentResponse,
  ) => Effect.Effect<
    void,
    | SessionNotFound
    | SessionRefMismatch
    | StoreReadError
    | HarnessSessionNotFound
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
  readonly getStatus: (ref: SessionRef) => Effect.Effect<SessionStatus, SessionNotActive>;
  readonly getSnapshot: (
    ref: SessionRef,
  ) => Effect.Effect<SessionRuntimeSnapshot, SessionNotActive>;
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

  const withSession = (ref: SessionRef) =>
    resolveHarnessSessionId(ref).pipe(Effect.flatMap((id) => manager.get(id)));

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
          return manager
            .open(
              harnessAgentId,
              {
                cwd,
                ...(config?.model !== undefined ? { model: config.model } : {}),
                ...(config?.reasoningEffort !== undefined
                  ? { reasoningEffort: config.reasoningEffort }
                  : {}),
                ...(config?.permissionMode !== undefined
                  ? { permissionMode: config.permissionMode }
                  : {}),
              },
              ref,
            )
            .pipe(
              Effect.flatMap((session) => {
                const metadata: Session = {
                  version: 1,
                  sessionId,
                  projectId,
                  harnessAgentId,
                  harnessSessionId: session.sessionId,
                  createdAt: new Date().toISOString(),
                  // Our own floor field: the session's working directory. Stored
                  // so an imported/rehomed session stays self-contained and a
                  // resume has cwd before it can call getSessionInfo.
                  cwd,
                };
                return repo.write(metadata).pipe(
                  // A failed metadata write must not leak the native session.
                  Effect.tapError(() => manager.close(session.sessionId)),
                  Effect.andThen(bus.publish({ ref, type: "session.created" })),
                  Effect.as(ref),
                );
              }),
            );
        }),
      ),

    resume: (ref, cwd) =>
      readChecked(ref).pipe(
        Effect.flatMap((metadata) =>
          manager.ensure(
            {
              sessionId: metadata.harnessSessionId,
              harnessAgentId: ref.harnessAgentId,
              cwd,
            },
            ref,
          ),
        ),
      ),

    close: (ref) =>
      resolveHarnessSessionId(ref).pipe(
        Effect.flatMap((harnessSessionId) =>
          manager
            .close(harnessSessionId)
            .pipe(Effect.andThen(bus.closeSession(ref, "session_closed"))),
        ),
      ),

    delete: (ref) =>
      readChecked(ref).pipe(
        Effect.flatMap((metadata) =>
          manager
            .close(metadata.harnessSessionId)
            .pipe(
              Effect.andThen(bus.closeSession(ref, "session_deleted")),
              Effect.andThen(repo.remove(ref.projectId, ref.sessionId)),
              Effect.andThen(bus.publish({ ref, type: "session.deleted" })),
            ),
        ),
      ),

    rename: (ref, name) =>
      resolveHarnessSessionId(ref).pipe(
        Effect.andThen(bus.publish({ ref, type: "session.renamed", name })),
      ),

    // A pure read of our own records — display data is self-owned (title from
    // the first prompt, createdAt/cwd from create), so no per-session backend
    // lookup. `status` is the one overlay, and it comes from the manager's
    // projection, not the harness index.
    list: (projectId) =>
      repo.list(projectId).pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(sessions, (metadata) =>
            manager
              .status({
                projectId: metadata.projectId,
                harnessAgentId: metadata.harnessAgentId,
                sessionId: metadata.sessionId,
              })
              .pipe(
                Effect.map((s): SessionStatus | null => s),
                Effect.catchTag("SessionNotActive", () => Effect.succeed(null)),
                Effect.map(
                  (status) =>
                    ({
                      projectId: metadata.projectId,
                      harnessAgentId: metadata.harnessAgentId,
                      sessionId: metadata.sessionId,
                      createdAt: metadata.createdAt,
                      // We own the record, so the session exists as far as we
                      // know; a resume (or a getMessages read) proves
                      // otherwise reactively.
                      historyAvailable: metadata.historyAvailable ?? true,
                      ...(metadata.title !== undefined ? { title: metadata.title } : {}),
                      ...(metadata.updatedAt !== undefined
                        ? { updatedAt: metadata.updatedAt }
                        : {}),
                      ...(status !== null ? { status } : {}),
                    }) satisfies SessionSummary,
                ),
              ),
          ),
        ),
      ),

    getMessages: (ref, cwd) =>
      readChecked(ref).pipe(
        Effect.flatMap((metadata) =>
          manager
            .ensure(
              { sessionId: metadata.harnessSessionId, harnessAgentId: ref.harnessAgentId, cwd },
              ref,
            )
            .pipe(
              Effect.andThen(manager.get(metadata.harnessSessionId)),
              Effect.flatMap(
                (
                  session,
                ): Effect.Effect<
                  ReadonlyArray<UIMessage>,
                  CapabilityUnsupported | SessionClosed | AgentOperationError
                > =>
                  session.getMessages ??
                  Effect.fail(
                    new CapabilityUnsupported({
                      harnessAgentId: ref.harnessAgentId,
                      capability: "getMessages",
                    }),
                  ),
              ),
              Effect.flatMap((messages) =>
                // History includes the in-flight turn's user entry; the live
                // stream replays that turn, so drop the last user segment while
                // a turn runs. A finished turn's buffer is retained
                // (complete: true) until the next turn starts — that is
                // settled history, not an in-flight turn, so it must not trim.
                // A missing projection degrades to no trimming.
                manager.snapshot(ref).pipe(
                  Effect.map((snapshot) => {
                    if (snapshot.activeTurn === null || snapshot.activeTurn.complete) {
                      return messages;
                    }
                    for (let index = messages.length - 1; index >= 0; index -= 1) {
                      if (messages[index]?.role === "user") return messages.slice(0, index);
                    }
                    return messages;
                  }),
                  Effect.catchTag("SessionNotActive", () => Effect.succeed(messages)),
                ),
              ),
            ),
        ),
      ),

    prompt: (input) =>
      Effect.gen(function* () {
        const metadata = yield* readChecked(input.ref);
        const userInput = yield* toUserInput(input.parts);
        // The first prompt names the session before it reaches the harness.
        yield* stampTitleFromFirstPrompt(metadata, input.parts);
        const session = yield* manager.get(metadata.harnessSessionId);
        const messageId = input.messageId ?? (yield* newSessionId);

        // Best-effort: a session whose runtime is gone will fail the prompt
        // itself with the real error a line later.
        const emitBestEffort = (body: SessionScopedEventBody) =>
          manager
            .emit(input.ref, body)
            .pipe(Effect.catchTag("SessionNotActive", () => Effect.void));

        // Broadcast the accepted prompt *before* the harness call so it always
        // precedes the turn's own events in seq order. If the harness then
        // rejects the prompt, `session.prompt.rejected` compensates — clients
        // drop the phantom user message and the runtime clears the retained
        // activePrompt.
        yield* emitBestEffort({
          type: "session.prompt.submitted",
          messageId,
          parts: input.parts,
        });
        return yield* session.prompt(userInput).pipe(
          Effect.tapError((promptError) =>
            emitBestEffort({
              type: "session.prompt.rejected",
              messageId,
              reason: promptError.message,
            }),
          ),
        );
      }),

    interrupt: (ref) => withSession(ref).pipe(Effect.flatMap((session) => session.interrupt)),

    setModel: (ref, model) =>
      withSession(ref).pipe(Effect.flatMap((session) => session.setModel(model))),

    setReasoningEffort: (ref, reasoningEffort) =>
      withSession(ref).pipe(
        Effect.flatMap((session) => session.setReasoningEffort(reasoningEffort)),
      ),

    setPermissionMode: (ref, permissionMode) =>
      withSession(ref).pipe(
        Effect.flatMap((session) =>
          // The session is open, so its adapter is registered by construction.
          checkPermissionMode(session.harnessAgentId, permissionMode).pipe(
            Effect.catchTag("HarnessAgentNotFound", (cause) =>
              Effect.die(
                new Error(
                  `invariant: open session '${session.sessionId}' has an unregistered adapter '${session.harnessAgentId}'`,
                  { cause },
                ),
              ),
            ),
            Effect.andThen(session.setPermissionMode(permissionMode)),
          ),
        ),
      ),

    respondToAgentRequest: (ref, requestId, response) =>
      withSession(ref).pipe(
        Effect.flatMap((session) => session.respondToAgentRequest(requestId, response)),
      ),

    getCapabilities: (ref) =>
      withSession(ref).pipe(Effect.flatMap((session) => session.getCapabilities)),

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
