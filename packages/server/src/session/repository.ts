import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { Context, Effect, Layer } from "effect";

import { Paths } from "../config/paths";
import { SessionNotFound, SessionRefNotFound, StoreReadError, StoreWriteError } from "../errors";
import { isEnoent, readJson, removeFile, writeJsonAtomic } from "../infra/json-store";
import type { Session } from "../types";

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
    const projectDir = (projectId: string) => join(paths.sessionsDir, projectId);
    const sessionFile = (projectId: string, sessionId: string) =>
      join(projectDir(projectId), `${sessionId}.json`);

    const readIds = (projectId: string): Effect.Effect<ReadonlyArray<string>, StoreReadError> =>
      Effect.tryPromise({
        try: async () => {
          try {
            const entries = await readdir(projectDir(projectId));
            return entries
              .filter((name) => name.endsWith(".json"))
              .map((name) => name.slice(0, -".json".length));
          } catch (cause) {
            if (isEnoent(cause)) return [];
            throw cause;
          }
        },
        catch: (cause) => new StoreReadError({ file: projectDir(projectId), cause }),
      });

    const read = (
      projectId: string,
      sessionId: string,
    ): Effect.Effect<Session, StoreReadError | SessionNotFound> =>
      // JSON.parse can never produce `undefined`, so the fallback is an
      // unambiguous "file absent" signal.
      readJson<Session | undefined>(sessionFile(projectId, sessionId), undefined).pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.fail(new SessionNotFound({ projectId, sessionId }))
            : Effect.succeed(value),
        ),
      );

    const listProjectIds = (): Effect.Effect<ReadonlyArray<string>, StoreReadError> =>
      Effect.tryPromise({
        try: async () => {
          try {
            const entries = await readdir(paths.sessionsDir, { withFileTypes: true });
            return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
          } catch (cause) {
            if (isEnoent(cause)) return [];
            throw cause;
          }
        },
        catch: (cause) => new StoreReadError({ file: paths.sessionsDir, cause }),
      });

    return {
      list: (projectId) =>
        readIds(projectId).pipe(
          Effect.flatMap((ids) =>
            Effect.forEach(
              ids,
              (sessionId) =>
                read(projectId, sessionId).pipe(
                  // A file that vanished between listing and reading is skipped,
                  // not fatal to the whole listing.
                  Effect.catchTag("SessionNotFound", () => Effect.succeed(null)),
                ),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map((entries) => entries.filter((entry) => entry !== null)),
        ),

      read,

      findBySessionId: (sessionId) =>
        listProjectIds().pipe(
          Effect.flatMap((projectIds) =>
            Effect.forEach(
              projectIds,
              (projectId) =>
                read(projectId, sessionId).pipe(
                  Effect.catchTag("SessionNotFound", () => Effect.succeed(null)),
                ),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map((hits) => hits.find((hit) => hit !== null)),
          Effect.flatMap((hit) =>
            hit ? Effect.succeed(hit) : Effect.fail(new SessionRefNotFound({ sessionId })),
          ),
        ),

      write: (metadata) =>
        writeJsonAtomic(sessionFile(metadata.projectId, metadata.sessionId), metadata),

      remove: (projectId, sessionId) => removeFile(sessionFile(projectId, sessionId)),
    };
  }),
);
