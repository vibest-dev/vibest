import { randomUUID } from "node:crypto";

import type { SessionRef, SessionSummary } from "@vibest/contract";
import { Context, Effect, Layer } from "effect";

import {
  type ProjectNotFound,
  SessionNotFound,
  SessionRefMismatch,
  type SessionRefNotFound,
  type StoreReadError,
  type StoreWriteError,
} from "../errors";
import { ProjectService } from "../project/service";
import type { HarnessAgentId, Session } from "../types";
import { type HarnessCreateError, type HarnessResumeError, HarnessSessionsPort } from "./port";
import { SessionRepository } from "./repository";

/**
 * Session orchestration. Owns everything the harness must stay ignorant of:
 * resolving a `projectId` to a workspace path, generating the server
 * `sessionId`, persisting {@link Session}, and translating a server
 * `SessionRef` to the agent-native `harnessSessionId` before calling the
 * {@link HarnessSessionsPort}. The harness only ever sees a cwd and a native id.
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
    /** Close the native session and delete its stored metadata. */
    readonly delete: (
      ref: SessionRef,
    ) => Effect.Effect<
      void,
      SessionNotFound | SessionRefMismatch | StoreReadError | StoreWriteError
    >;
    readonly list: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<SessionSummary>, ProjectNotFound | StoreReadError>;
    /**
     * Server `SessionRef` → agent-native `harnessSessionId`, verifying the ref's
     * harnessAgentId matches the stored metadata. The seam later methods
     * (prompt, interrupt, subscribe) call before reaching the harness.
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
  ProjectService | SessionRepository | HarnessSessionsPort
> = Layer.effect(
  SessionService,
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    const repo = yield* SessionRepository;
    const harness = yield* HarnessSessionsPort;

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

    return {
      create: (projectId, harnessAgentId) =>
        projects.findById(projectId).pipe(
          Effect.flatMap((project) =>
            harness.create(harnessAgentId, project.path).pipe(
              Effect.flatMap((harnessSessionId) => {
                const sessionId = randomUUID();
                const metadata: Session = {
                  version: 1,
                  projectId,
                  harnessAgentId,
                  harnessSessionId,
                  createdAt: new Date().toISOString(),
                };
                return repo.write(sessionId, metadata).pipe(
                  Effect.as({ projectId, harnessAgentId, sessionId } satisfies SessionRef),
                  // A failed metadata write must not leak the native session.
                  Effect.tapError(() => harness.close(harnessSessionId)),
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
                harness.resume(ref.harnessAgentId, metadata.harnessSessionId, project.path),
              ),
              Effect.as(ref),
            ),
          ),
        ),

      close: (ref) =>
        resolveHarnessSessionId(ref).pipe(
          Effect.flatMap((harnessSessionId) => harness.close(harnessSessionId)),
        ),

      delete: (ref) =>
        readChecked(ref).pipe(
          Effect.flatMap((metadata) =>
            harness
              .close(metadata.harnessSessionId)
              .pipe(Effect.andThen(repo.remove(ref.projectId, ref.sessionId))),
          ),
        ),

      list: (projectId) =>
        projects.findById(projectId).pipe(
          Effect.flatMap(() => repo.list(projectId)),
          Effect.map((entries) =>
            entries.map(
              ({ sessionId, metadata }): SessionSummary => ({
                projectId: metadata.projectId,
                harnessAgentId: metadata.harnessAgentId,
                sessionId,
                createdAt: metadata.createdAt,
                // Best-effort until native history reads land (ticket 09/10);
                // a metadata file without readable native history flips this.
                historyAvailable: true,
              }),
            ),
          ),
        ),

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
