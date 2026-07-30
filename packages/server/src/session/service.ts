import crypto from "node:crypto";

import type {
  AgentResponse,
  PermissionMode,
  PromptInput,
  ReasoningEffort,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionStatus,
  SessionSummary,
} from "@vibest/contract";
import { Context, Effect, Layer } from "effect";

import {
  type ProjectNotFound,
  SessionNotFound,
  SessionRefMismatch,
  type SessionRefNotFound,
  type StoreReadError,
  type StoreWriteError,
  UnsupportedPromptPart,
} from "../errors";
import { EventBus } from "../events";
import type { PermissionModeUnsupported, PromptReceipt, UserInput } from "../harness";
import { ProjectService } from "../project/service";
import type { HarnessAgentId, Session } from "../types";
import {
  HarnessAgentSessionPort,
  type HarnessCreateError,
  type HarnessInterruptError,
  type HarnessPromptError,
  type HarnessRespondError,
  type HarnessResumeError,
  type HarnessSetConfigError,
} from "./port";
import { SessionRepository } from "./repository";
import { SessionManager, type SessionNotActive } from "./runtime";

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

/**
 * The outward session façade — everything the app's session control-plane goes
 * through. Owns what the HarnessAgent must stay ignorant of: resolving a
 * `projectId` to a workspace path, generating the server `sessionId`, persisting
 * {@link Session}, translating a `SessionRef` to the agent-native
 * `harnessSessionId` before reaching the {@link HarnessAgentSessionPort}, and
 * the lifecycle of the in-memory {@link SessionManager} runtimes (start on
 * create/resume, stop on close/delete) plus the collection events that announce
 * them. `status` in a listing is present exactly when a runtime is live.
 */
export class SessionService extends Context.Service<
  SessionService,
  {
    readonly create: (
      projectId: string,
      harnessAgentId: HarnessAgentId,
      config?: {
        readonly model?: string;
        readonly reasoningEffort?: ReasoningEffort;
        readonly permissionMode?: PermissionMode;
      },
    ) => Effect.Effect<
      SessionRef,
      ProjectNotFound | HarnessCreateError | StoreReadError | StoreWriteError
    >;
    readonly resume: (
      ref: SessionRef,
    ) => Effect.Effect<
      SessionRef,
      SessionNotFound | SessionRefMismatch | ProjectNotFound | HarnessResumeError | StoreReadError
    >;
    readonly close: (
      ref: SessionRef,
    ) => Effect.Effect<void, SessionNotFound | SessionRefMismatch | StoreReadError>;
    /** Stop the runtime, close the native session, and delete its metadata. */
    readonly delete: (
      ref: SessionRef,
    ) => Effect.Effect<
      void,
      SessionNotFound | SessionRefMismatch | StoreReadError | StoreWriteError
    >;
    readonly rename: (
      ref: SessionRef,
      name: string,
    ) => Effect.Effect<void, SessionNotFound | SessionRefMismatch | StoreReadError>;
    readonly list: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<SessionSummary>, ProjectNotFound | StoreReadError>;
    readonly prompt: (
      input: PromptInput,
    ) => Effect.Effect<
      PromptReceipt,
      | SessionNotFound
      | SessionRefMismatch
      | StoreReadError
      | UnsupportedPromptPart
      | HarnessPromptError
    >;
    readonly interrupt: (
      ref: SessionRef,
    ) => Effect.Effect<
      void,
      SessionNotFound | SessionRefMismatch | StoreReadError | HarnessInterruptError
    >;
    // Session-scoped config setters. `model` is the provider-local model id —
    // the RPC layer unpacked and validated the providerId/modelId pair before this façade.
    readonly setModel: (
      ref: SessionRef,
      model: string,
    ) => Effect.Effect<
      void,
      SessionNotFound | SessionRefMismatch | StoreReadError | HarnessSetConfigError
    >;
    readonly setReasoningEffort: (
      ref: SessionRef,
      reasoningEffort: ReasoningEffort,
    ) => Effect.Effect<
      void,
      SessionNotFound | SessionRefMismatch | StoreReadError | HarnessSetConfigError
    >;
    readonly setPermissionMode: (
      ref: SessionRef,
      permissionMode: PermissionMode,
    ) => Effect.Effect<
      void,
      | SessionNotFound
      | SessionRefMismatch
      | StoreReadError
      | HarnessSetConfigError
      | PermissionModeUnsupported
    >;
    readonly respondToAgentRequest: (
      ref: SessionRef,
      requestId: string,
      response: AgentResponse,
    ) => Effect.Effect<
      void,
      SessionNotFound | SessionRefMismatch | StoreReadError | HarnessRespondError
    >;
    readonly getStatus: (ref: SessionRef) => Effect.Effect<SessionStatus, SessionNotActive>;
    readonly getSnapshot: (
      ref: SessionRef,
    ) => Effect.Effect<SessionRuntimeSnapshot, SessionNotActive>;
    /**
     * Server `SessionRef` → agent-native `harnessSessionId`, verifying the ref's
     * harnessAgentId matches the stored metadata.
     */
    readonly resolveHarnessSessionId: (
      ref: SessionRef,
    ) => Effect.Effect<string, SessionNotFound | SessionRefMismatch | StoreReadError>;
    /** Reverse a bare sessionId back into its full SessionRef. */
    readonly resolveRef: (
      sessionId: string,
    ) => Effect.Effect<SessionRef, StoreReadError | SessionRefNotFound>;
  }
>()("SessionService") {}

export const SessionServiceLayer: Layer.Layer<
  SessionService,
  never,
  ProjectService | SessionRepository | HarnessAgentSessionPort | SessionManager | EventBus
> = Layer.effect(
  SessionService,
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    const repo = yield* SessionRepository;
    const port = yield* HarnessAgentSessionPort;
    const manager = yield* SessionManager;
    const bus = yield* EventBus;

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

    // Drain the native event stream into a fresh runtime. A session that 404s on
    // its own stream right after create/resume is a bug, not a user-facing error.
    // On a stream crash the manager keeps the projection queryable (phase
    // "crashed"); releasing the native session's resources is our side.
    const startRuntime = (ref: SessionRef, harnessSessionId: string) =>
      port.events(harnessSessionId).pipe(
        Effect.flatMap((events) =>
          manager.start(ref, events, { onCrash: port.close(harnessSessionId) }),
        ),
        Effect.orDie,
      );

    return {
      create: (projectId, harnessAgentId, config) =>
        projects.findById(projectId).pipe(
          Effect.flatMap((project) =>
            port.create(harnessAgentId, project.path, config).pipe(
              Effect.flatMap((harnessSessionId) => {
                const sessionId = crypto.randomUUID();
                const metadata: Session = {
                  version: 1,
                  sessionId,
                  projectId,
                  harnessAgentId,
                  harnessSessionId,
                  createdAt: new Date().toISOString(),
                  // Our own floor field: the session's working directory. Stored
                  // so an imported/rehomed session stays self-contained and a
                  // resume has cwd before it can call getSessionInfo.
                  cwd: project.path,
                };
                const ref: SessionRef = { projectId, harnessAgentId, sessionId };
                return repo.write(metadata).pipe(
                  // A failed metadata write must not leak the native session.
                  Effect.tapError(() => port.close(harnessSessionId)),
                  Effect.andThen(startRuntime(ref, harnessSessionId)),
                  Effect.andThen(bus.publish({ ref, type: "session.created" })),
                  Effect.as(ref),
                );
              }),
            ),
          ),
        ),

      resume: (ref) =>
        readChecked(ref).pipe(
          Effect.flatMap((metadata) =>
            projects.findById(metadata.projectId).pipe(
              Effect.flatMap((project) =>
                port.resume(ref.harnessAgentId, metadata.harnessSessionId, project.path),
              ),
              Effect.andThen(startRuntime(ref, metadata.harnessSessionId)),
              Effect.as(ref),
            ),
          ),
        ),

      close: (ref) =>
        resolveHarnessSessionId(ref).pipe(
          Effect.flatMap((harnessSessionId) =>
            manager
              .stop(ref)
              .pipe(
                Effect.andThen(bus.closeSession(ref, "session_closed")),
                Effect.andThen(port.close(harnessSessionId)),
              ),
          ),
        ),

      delete: (ref) =>
        readChecked(ref).pipe(
          Effect.flatMap((metadata) =>
            manager
              .stop(ref)
              .pipe(
                Effect.andThen(bus.closeSession(ref, "session_deleted")),
                Effect.andThen(port.close(metadata.harnessSessionId)),
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
      // lookup. `status` is the one overlay, and it comes from the in-memory
      // runtime, not the harness index.
      list: (projectId) =>
        projects.findById(projectId).pipe(
          Effect.andThen(repo.list(projectId)),
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
                        // know; a resume proves otherwise reactively. History
                        // isn't served yet regardless (getMessages is UNSUPPORTED).
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

      prompt: (input) =>
        readChecked(input.ref).pipe(
          Effect.flatMap((metadata) =>
            toUserInput(input.parts).pipe(
              Effect.flatMap((userInput) =>
                // The first prompt names the session before it reaches the harness.
                stampTitleFromFirstPrompt(metadata, input.parts).pipe(
                  Effect.andThen(port.prompt(metadata.harnessSessionId, userInput)),
                ),
              ),
            ),
          ),
        ),

      interrupt: (ref) =>
        resolveHarnessSessionId(ref).pipe(Effect.flatMap((id) => port.interrupt(id))),

      setModel: (ref, model) =>
        resolveHarnessSessionId(ref).pipe(Effect.flatMap((id) => port.setModel(id, model))),

      setReasoningEffort: (ref, reasoningEffort) =>
        resolveHarnessSessionId(ref).pipe(
          Effect.flatMap((id) => port.setReasoningEffort(id, reasoningEffort)),
        ),

      setPermissionMode: (ref, permissionMode) =>
        resolveHarnessSessionId(ref).pipe(
          Effect.flatMap((id) => port.setPermissionMode(id, permissionMode)),
        ),

      respondToAgentRequest: (ref, requestId, response) =>
        resolveHarnessSessionId(ref).pipe(
          Effect.flatMap((id) => port.respondToAgentRequest(id, requestId, response)),
        ),

      getStatus: (ref) => manager.status(ref),
      getSnapshot: (ref) => manager.snapshot(ref),

      resolveHarnessSessionId,

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
    };
  }),
);
