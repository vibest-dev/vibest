import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { type JsonStoreLoadError, makeJsonCollection } from "@vibest/effect-json-store";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { Paths } from "../config/paths";
import { SessionNotFound, SessionRefNotFound, StoreReadError, StoreWriteError } from "../errors";
import type { Session } from "../types";

/**
 * Persistence schema for {@link Session}. Compatibility with the interface is
 * enforced structurally: `write` checks Session → schema Type, the readers
 * check schema Type → Session.
 */
const SessionSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  projectId: Schema.String,
  harnessAgentId: Schema.Literals(["claude-code", "codex", "pi"]),
  harnessSessionId: Schema.String,
  createdAt: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
  historyAvailable: Schema.optionalKey(Schema.Boolean),
});

/**
 * Data access for `storage/sessions/<projectId>/<sessionId>.json`. The filename
 * mirrors {@link Session.sessionId}, which the body also carries. No business
 * rules — orchestration (id generation, projectId resolution) lives in
 * SessionService.
 */
export class SessionRepository extends Context.Service<
  SessionRepository,
  {
    /** All session metadata under a project; empty if the project dir is absent. */
    readonly list: (projectId: string) => Effect.Effect<ReadonlyArray<Session>, StoreReadError>;
    readonly read: (
      projectId: string,
      sessionId: string,
    ) => Effect.Effect<Session, StoreReadError | SessionNotFound>;
    /**
     * Reverse lookup: find a session by its (globally unique) sessionId alone,
     * scanning every project directory. The record carries its own projectId.
     */
    readonly findBySessionId: (
      sessionId: string,
    ) => Effect.Effect<Session, StoreReadError | SessionRefNotFound>;
    readonly write: (metadata: Session) => Effect.Effect<void, StoreWriteError>;
    /** Idempotent: removing an absent file succeeds. */
    readonly remove: (projectId: string, sessionId: string) => Effect.Effect<void, StoreWriteError>;
  }
>()("SessionRepository") {}

export const SessionRepositoryLayer: Layer.Layer<SessionRepository, never, Paths> = Layer.effect(
  SessionRepository,
  Effect.gen(function* () {
    const paths = yield* Paths;
    const sessions = yield* makeJsonCollection({
      dir: paths.sessionsDir,
      schema: SessionSchema,
      // Pre-envelope records are the bare body, already in the v1 shape.
      legacy: { schema: SessionSchema, migrate: (session) => session },
    });
    const entryId = (projectId: string, sessionId: string) => `${projectId}/${sessionId}`;
    const asReadError = (error: JsonStoreLoadError) =>
      new StoreReadError({ file: error.file, cause: error });
    const asWriteError = (error: { readonly file: string }) =>
      new StoreWriteError({ file: error.file, cause: error });

    return {
      list: (projectId) =>
        sessions
          .list((entry) => entry.data.projectId === projectId)
          .pipe(
            Effect.map((entries) => entries.map((entry) => entry.data)),
            Effect.mapError(asReadError),
          ),

      read: (projectId, sessionId) =>
        sessions.get(entryId(projectId, sessionId)).pipe(
          Effect.mapError(asReadError),
          Effect.flatMap((found) =>
            Option.isSome(found)
              ? Effect.succeed(found.value)
              : Effect.fail(new SessionNotFound({ projectId, sessionId })),
          ),
        ),

      findBySessionId: (sessionId) =>
        sessions
          .list((entry) => entry.data.sessionId === sessionId)
          .pipe(
            Effect.mapError(asReadError),
            Effect.flatMap((hits) => {
              const hit = hits[0];
              return hit === undefined
                ? Effect.fail(new SessionRefNotFound({ sessionId }))
                : Effect.succeed(hit.data);
            }),
          ),

      write: (metadata) =>
        sessions
          .put(entryId(metadata.projectId, metadata.sessionId), metadata)
          .pipe(Effect.mapError(asWriteError)),

      remove: (projectId, sessionId) =>
        sessions.remove(entryId(projectId, sessionId)).pipe(Effect.mapError(asWriteError)),
    };
  }),
).pipe(Layer.provide(NodeFileSystem.layer));
