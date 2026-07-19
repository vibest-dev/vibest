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

    // Drain the native event stream into a fresh runtime. A session that 404s on
    // its own stream right after create/resume is a bug, not a user-facing error.
    const startRuntime = (ref: SessionRef, harnessSessionId: string) =>
      port.events(harnessSessionId).pipe(
        Effect.flatMap((events) => manager.start(ref, events)),
        Effect.orDie,
      );

    return {
      create: (projectId, harnessAgentId) =>
        projects.findById(projectId).pipe(
          Effect.flatMap((project) =>
            port.create(harnessAgentId, project.path).pipe(
              Effect.flatMap((harnessSessionId) => {
                const sessionId = randomUUID();
                const metadata: Session = {
                  version: 1,
                  projectId,
                  harnessAgentId,
                  harnessSessionId,
                  createdAt: new Date().toISOString(),
                };
                const ref: SessionRef = { projectId, harnessAgentId, sessionId };
                return repo.write(sessionId, metadata).pipe(
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
          Effect.flatMap(() => repo.list(projectId)),
          Effect.flatMap((entries) =>
            Effect.forEach(entries, ({ sessionId, metadata }) => {
              const ref: SessionRef = {
                projectId: metadata.projectId,
                harnessAgentId: metadata.harnessAgentId,
                sessionId,
              };
              const base: SessionSummary = {
                projectId: metadata.projectId,
                harnessAgentId: metadata.harnessAgentId,
                sessionId,
                createdAt: metadata.createdAt,
                // Best-effort until native history reads land (ticket 10/11); a
                // metadata file without readable native history flips this.
                historyAvailable: true,
              };
              // Merge the live phase from the runtime; a session with no runtime
              // simply carries no status.
              return manager.status(ref).pipe(
                Effect.map((status): SessionSummary => ({ ...base, status })),
                Effect.catchTag("SessionNotActive", () => Effect.succeed(base)),
              );
            }),
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
            ({ projectId, metadata }): SessionRef => ({
              projectId,
              harnessAgentId: metadata.harnessAgentId,
              sessionId,
            }),
          ),
        ),
    };
  }),
);
