import { type JsonStoreLoadError, makeJsonCollection } from "@vibest/effect-json-store";
import { Effect, Option, Schema } from "effect";

import { SessionNotFound, SessionRefNotFound, StoreReadError, StoreWriteError } from "../errors";
import type { Session } from "../types";

/**
 * Persistence schema for {@link Session}. Compatibility with the interface is
 * enforced structurally: `write` checks Session → schema Type, {@link toSession}
 * checks schema Type → Session.
 *
 * `sessionId` is written into every record — a stored record is meant to be
 * complete on its own — but is *optional to read back*, because the oldest
 * records predate the field: it lived only in the filename then. Requiring it
 * here is what made those records undecodable, which failed the whole
 * project's `list` and emptied its sidebar group.
 */
const SessionSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.optionalKey(Schema.String),
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
 * Complete a stored body with the id it was addressed by.
 *
 * Every read here already knows that id — `read` and `findBySessionId` take it
 * as an argument, `list` has it in the entry id — so an old record missing the
 * field costs nothing to serve, and a record whose stored copy has drifted from
 * its own filename resolves to the filename rather than to a value nothing can
 * look it up by. The optional field never reaches a caller.
 */
const toSession = (sessionId: string, body: typeof SessionSchema.Type): Session => ({
  ...body,
  sessionId,
});

/**
 * Data access for `storage/sessions/<projectId>/<sessionId>.json`. The filename
 * mirrors {@link Session.sessionId}, which the body also carries. No business
 * rules — orchestration (id generation, projectId resolution) lives in
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
      schema: SessionSchema,
      // Pre-envelope records are the bare body, already in the v1 shape — true
      // now that the schema stops requiring the one field they can lack.
      legacy: { schema: SessionSchema, migrate: (session) => session },
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
                  ? Option.none<typeof SessionSchema.Type>()
                  : yield* sessions.get(id).pipe(Effect.mapError(asReadError));
              if (Option.isNone(found)) {
                return yield* Effect.fail(new SessionRefNotFound({ sessionId }));
              }
              return toSession(sessionId, found.value);
            }),

      write: (metadata) =>
        sessions
          .put(entryId(metadata.projectId, metadata.sessionId), metadata)
          .pipe(Effect.mapError(asWriteError)),

      remove: (projectId, sessionId) =>
        !isSafeId(projectId) || !isSafeId(sessionId)
          ? Effect.void
          : sessions.remove(entryId(projectId, sessionId)).pipe(Effect.mapError(asWriteError)),
    } satisfies HarnessAgentSessionRepositoryShape;
  });
