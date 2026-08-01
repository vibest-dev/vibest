import { type JsonStoreLoadError, makeJsonCollection } from "@vibest/effect-json-store";
import { Effect, Option, Schema } from "effect";

import { SessionNotFound, SessionRefNotFound, StoreReadError, StoreWriteError } from "../errors";
import type { Session } from "../types";

/**
 * Persistence schema for {@link Session} — everything *except* `sessionId`,
 * which is the filename and is put back by {@link toSession} on read.
 *
 * Storing it in the body too would be a second copy of an address the path
 * already holds, free to drift from it and never consulted when it does: every
 * lookup here goes through the path. It is also what made the oldest records
 * unreadable — they predate the field, which until then lived only in the
 * filename, so requiring it in the body rejected them outright.
 *
 * Compatibility with the interface is enforced structurally: `write` checks
 * Session → schema Type, {@link toSession} checks schema Type → Session.
 */
const SessionBodySchema = Schema.Struct({
  version: Schema.Literal(1),
  projectId: Schema.String,
  harnessAgentId: Schema.Literals(["claude-code", "codex", "pi"]),
  harnessSessionId: Schema.String,
  createdAt: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
  historyAvailable: Schema.optionalKey(Schema.Boolean),
});

/** Rejoin a stored body with the `sessionId` its filename carried. */
const toSession = (sessionId: string, body: typeof SessionBodySchema.Type): Session => ({
  ...body,
  sessionId,
});

/**
 * Data access for `storage/sessions/<projectId>/<sessionId>.json`. The filename
 * is the sole home of {@link Session.sessionId}. No business rules —
 * orchestration (id generation, projectId resolution) lives in
 * {@link HarnessAgentSessionService}, whose internal collaborator this is; it
 * has no Context tag of its own.
 */
export type HarnessAgentSessionRepositoryShape = {
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
};

/**
 * Ids reach this repository from RPC input, so they must be sanitized before
 * they become path segments: the collection treats an invalid id as a defect
 * (caller bug), but here a malformed id is client data and means "no such
 * session", not a crash.
 */
const isSafeId = (id: string): boolean =>
  id.length > 0 && !/[/\\]/.test(id) && id !== "." && id !== "..";

export const makeHarnessAgentSessionRepository = (sessionsDir: string) =>
  Effect.gen(function* () {
    const sessions = yield* makeJsonCollection({
      dir: sessionsDir,
      schema: SessionBodySchema,
      // Pre-envelope records are the bare body, already in the v1 shape — which
      // holds only because the body schema stops at what those records had.
      legacy: { schema: SessionBodySchema, migrate: (body) => body },
    });
    const entryId = (projectId: string, sessionId: string) => `${projectId}/${sessionId}`;
    // Entry ids are `<projectId>/<sessionId>`; only `list` has to take one apart.
    const sessionIdOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
    const asReadError = (error: JsonStoreLoadError) =>
      new StoreReadError({ file: error.file, cause: error });
    const asWriteError = (error: { readonly file: string }) =>
      new StoreWriteError({ file: error.file, cause: error });

    return {
      list: (projectId) =>
        // Scoped to the project's own subdirectory: a corrupt record in
        // another project cannot fail this listing.
        isSafeId(projectId)
          ? sessions.list({ under: projectId }).pipe(
              Effect.map((entries) =>
                entries.map((entry) => toSession(sessionIdOf(entry.id), entry.data)),
              ),
              Effect.mapError(asReadError),
            )
          : Effect.succeed([]),

      read: (projectId, sessionId) =>
        !isSafeId(projectId) || !isSafeId(sessionId)
          ? Effect.fail(new SessionNotFound({ projectId, sessionId }))
          : sessions.get(entryId(projectId, sessionId)).pipe(
              Effect.mapError(asReadError),
              Effect.flatMap((found) =>
                Option.isSome(found)
                  ? Effect.succeed(toSession(sessionId, found.value))
                  : Effect.fail(new SessionNotFound({ projectId, sessionId })),
              ),
            ),

      findBySessionId: (sessionId) =>
        // Scan filenames only (no entry bodies), then read the single match.
        !isSafeId(sessionId)
          ? Effect.fail(new SessionRefNotFound({ sessionId }))
          : Effect.gen(function* () {
              const ids = yield* sessions.ids().pipe(Effect.mapError(asReadError));
              const id = ids.find((candidate) => candidate.endsWith(`/${sessionId}`));
              const found =
                id === undefined
                  ? Option.none<typeof SessionBodySchema.Type>()
                  : yield* sessions.get(id).pipe(Effect.mapError(asReadError));
              if (Option.isNone(found)) {
                return yield* Effect.fail(new SessionRefNotFound({ sessionId }));
              }
              return toSession(sessionId, found.value);
            }),

      // Split explicitly rather than letting the encoder drop the extra key:
      // this is the one place the id leaves the body for the path, and it
      // should fail to compile — not silently strip — if that ever changes.
      write: ({ sessionId, ...body }) =>
        sessions.put(entryId(body.projectId, sessionId), body).pipe(Effect.mapError(asWriteError)),

      remove: (projectId, sessionId) =>
        !isSafeId(projectId) || !isSafeId(sessionId)
          ? Effect.void
          : sessions.remove(entryId(projectId, sessionId)).pipe(Effect.mapError(asWriteError)),
    } satisfies HarnessAgentSessionRepositoryShape;
  });
