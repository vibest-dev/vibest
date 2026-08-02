import path from "node:path";

import { type JsonStoreLoadError, makeJsonCollection } from "@vibest/effect-json-store";
import { Effect, Option, Schema } from "effect";

import { SessionNotFound, SessionRefNotFound, StoreReadError, StoreWriteError } from "../errors";
import type { Session } from "../types";

const SessionFields = {
  version: Schema.Literal(1),
  projectId: Schema.String,
  harnessAgentId: Schema.Literals(["claude-code", "codex", "pi"]),
  harnessSessionId: Schema.String,
  createdAt: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
  historyAvailable: Schema.optionalKey(Schema.Boolean),
};

/**
 * Persistence schema for {@link Session}. Compatibility with the interface is
 * enforced structurally: `write` checks Session → schema Type, the readers
 * check schema Type → Session.
 *
 * A stored record carries its own `sessionId` even though the filename already
 * is one, so that a record loaded on its own is complete — nothing here has to
 * be handed its address alongside its contents to make sense of it.
 */
const SessionSchema = Schema.Struct({ ...SessionFields, sessionId: Schema.String });

/**
 * The pre-envelope shape, which is {@link SessionSchema} *before* the body
 * carried its own `sessionId` — back then the filename was the only copy.
 *
 * This is why the legacy step cannot be the identity: those records are a
 * field short of the v1 shape, and reusing `SessionSchema` here (as this once
 * did, on the strength of a comment claiming they matched) rejected every one
 * of them at decode, which failed the whole project's `list`.
 */
const PreEnvelopeSessionSchema = Schema.Struct(SessionFields);

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
      legacy: {
        schema: PreEnvelopeSessionSchema,
        // Adoption fills in the field those records never had, from the only
        // place that held it: `<projectId>/<sessionId>.json`. The write-back
        // is what makes it permanent, so this runs once per old record.
        migrate: (body, { file }) => ({ ...body, sessionId: path.basename(file, ".json") }),
      },
    });
    const entryId = (projectId: string, sessionId: string) => `${projectId}/${sessionId}`;
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
              Effect.map((entries) => entries.map((entry) => entry.data)),
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
                  ? Effect.succeed(found.value)
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
                  ? Option.none<Session>()
                  : yield* sessions.get(id).pipe(Effect.mapError(asReadError));
              if (Option.isNone(found)) {
                return yield* Effect.fail(new SessionRefNotFound({ sessionId }));
              }
              return found.value;
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
