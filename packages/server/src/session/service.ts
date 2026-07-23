import { randomUUID } from "node:crypto";

import type {
  AgentResponse,
  PromptInput,
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
import type { PromptReceipt, UserInput } from "../harness";
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

/** Wire prompt parts → HarnessAgent UserInput; `file` parts are rejected, never dropped. */
const toUserInput = (
  parts: PromptInput["parts"],
  model: string | undefined,
): Effect.Effect<UserInput, UnsupportedPromptPart> =>
  Effect.forEach(parts, (part) =>
    part.type === "file"
      ? Effect.fail(new UnsupportedPromptPart({ kind: "file" }))
      : Effect.succeed(part),
  ).pipe(
    Effect.map((userParts) => ({
      parts: userParts,
      ...(model !== undefined ? { model } : {}),
    })),
  );

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
      config?: { readonly model?: string; readonly permissionMode?: string },
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
    /** Session-scoped config setters; values use the harness's outward vocabulary. */
    readonly setModel: (
      ref: SessionRef,
      model: string,
    ) => Effect.Effect<
      void,
      SessionNotFound | SessionRefMismatch | StoreReadError | HarnessSetConfigError
    >;
    readonly setPermissionMode: (
      ref: SessionRef,
      permissionMode: string,
    ) => Effect.Effect<
      void,
      SessionNotFound | SessionRefMismatch | StoreReadError | HarnessSetConfigError
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

    // Reconcile a record's display overlay against the harness index and persist
    // it back, so a subsequent `list` reads storage without a backend round-trip.
    // Called lazily from `list` for records that were never reconciled (no
    // stored title). `found` refreshes title/updatedAt and marks history
    // available; `missing` records that the transcript is gone; `unsupported`
    // (pi) leaves the floor untouched. A write only happens when something
    // actually changed.
    const reconcileDisplay = (cwd: string, metadata: Session) =>
      port.getSessionInfo(metadata.harnessAgentId, metadata.harnessSessionId, cwd).pipe(
        Effect.flatMap((info) => {
          const next: Session =
            info._tag === "found"
              ? {
                  ...metadata,
                  historyAvailable: true,
                  ...(info.info.title !== undefined ? { title: info.info.title } : {}),
                  ...(info.info.updatedAt !== undefined
                    ? { updatedAt: new Date(info.info.updatedAt).toISOString() }
                    : {}),
                }
              : info._tag === "missing"
                ? { ...metadata, historyAvailable: false }
                : metadata;
          const changed =
            next.title !== metadata.title ||
            next.updatedAt !== metadata.updatedAt ||
            next.historyAvailable !== metadata.historyAvailable;
          // Persisting the heal is best-effort: a failed write must not fail the
          // list. Return the reconciled record anyway (this list still shows the
          // title); the next list re-heals and retries the write.
          return changed
            ? repo.write(next).pipe(
                Effect.as(next),
                Effect.catchTag("StoreWriteError", () => Effect.succeed(next)),
              )
            : Effect.succeed(metadata);
        }),
      );

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
                const sessionId = randomUUID();
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

      list: (projectId) =>
        projects.findById(projectId).pipe(
          Effect.flatMap((project) =>
            repo.list(projectId).pipe(
              Effect.flatMap((sessions) =>
                Effect.forEach(
                  sessions,
                  (metadata) =>
                    Effect.gen(function* () {
                      const ref: SessionRef = {
                        projectId: metadata.projectId,
                        harnessAgentId: metadata.harnessAgentId,
                        sessionId: metadata.sessionId,
                      };
                      // Display fields come from our own record (the floor +
                      // persisted overlay). A record that was never reconciled
                      // (no stored title) is healed once here — one backend
                      // lookup, persisted back — and read straight from storage
                      // ever after. So the per-list backend cost decays to zero
                      // as titles settle, instead of a lookup per session every
                      // time. pi (unsupported) has no title to store, so it is
                      // re-checked each list, but its getSessionInfo is a pure
                      // in-memory `unsupported` — no I/O.
                      const record =
                        metadata.title !== undefined
                          ? metadata
                          : yield* reconcileDisplay(metadata.cwd ?? project.path, metadata);
                      // Live phase from the runtime; null when no runtime is up.
                      const status = yield* manager.status(ref).pipe(
                        Effect.map((s): SessionStatus | null => s),
                        Effect.catchTag("SessionNotActive", () => Effect.succeed(null)),
                      );
                      return {
                        projectId: record.projectId,
                        harnessAgentId: record.harnessAgentId,
                        sessionId: record.sessionId,
                        createdAt: record.createdAt,
                        // `found` → true, `missing` → false (both persisted by the
                        // heal above and read back here). Absent means no positive
                        // evidence — a backend with no index (pi/unsupported) or a
                        // record that couldn't be reconciled — which reads as
                        // false, same as before this became storage-backed.
                        historyAvailable: record.historyAvailable ?? false,
                        ...(record.title !== undefined ? { title: record.title } : {}),
                        ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
                        ...(status !== null ? { status } : {}),
                      } satisfies SessionSummary;
                    }),
                  // Bounded: the lazy heal above can still fan a handful of
                  // backend lookups out on the first list of a project with many
                  // never-reconciled sessions, on the connection that also carries
                  // the live chat stream.
                  { concurrency: 8 },
                ),
              ),
            ),
          ),
        ),

      prompt: (input) =>
        resolveHarnessSessionId(input.ref).pipe(
          Effect.flatMap((harnessSessionId) =>
            toUserInput(input.parts, input.model).pipe(
              Effect.flatMap((userInput) => port.prompt(harnessSessionId, userInput)),
            ),
          ),
        ),

      interrupt: (ref) =>
        resolveHarnessSessionId(ref).pipe(Effect.flatMap((id) => port.interrupt(id))),

      setModel: (ref, model) =>
        resolveHarnessSessionId(ref).pipe(Effect.flatMap((id) => port.setModel(id, model))),

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
