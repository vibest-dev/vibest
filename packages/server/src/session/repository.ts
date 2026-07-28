import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { Paths } from "../config/paths";
import { SessionNotFound, SessionRefNotFound, StoreReadError, StoreWriteError } from "../errors";
import {
  isNotFound,
  readJson,
  removeFile,
  writeJsonAtomic,
  type JsonStorePlatform,
} from "../infra/json-store";
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

export const SessionRepositoryLayer: Layer.Layer<
  SessionRepository,
  never,
  Paths | JsonStorePlatform
> = Layer.effect(
  SessionRepository,
  Effect.gen(function* () {
    const paths = yield* Paths;
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    // Bind the platform services once so the methods below stay R-free; the
    // Layer's R carries the requirement to the composition root instead.
    const platform = yield* Effect.context<JsonStorePlatform>();

    const projectDir = (projectId: string) => pathService.join(paths.sessionsDir, projectId);
    const sessionFile = (projectId: string, sessionId: string) =>
      pathService.join(projectDir(projectId), `${sessionId}.json`);

    /** Directory entries, or `[]` when the directory has never been written. */
    const readDirOrEmpty = (dir: string): Effect.Effect<ReadonlyArray<string>, StoreReadError> =>
      fs.readDirectory(dir).pipe(
        Effect.catchIf(isNotFound, () => Effect.succeed<Array<string>>([])),
        Effect.mapError((cause) => new StoreReadError({ file: dir, cause })),
      );

    const readIds = (projectId: string): Effect.Effect<ReadonlyArray<string>, StoreReadError> =>
      readDirOrEmpty(projectDir(projectId)).pipe(
        Effect.map((names) =>
          names
            .filter((name) => name.endsWith(".json"))
            .map((name) => name.slice(0, -".json".length)),
        ),
      );

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
        Effect.provide(platform),
      );

    // `readDirectory` yields names only, so each entry is stat'd to keep just the
    // directories. A failing stat (raced deletion, broken symlink) drops that
    // entry rather than the whole listing.
    const listProjectIds = (): Effect.Effect<ReadonlyArray<string>, StoreReadError> =>
      readDirOrEmpty(paths.sessionsDir).pipe(
        Effect.flatMap((names) =>
          Effect.forEach(
            names,
            (name) =>
              fs.stat(pathService.join(paths.sessionsDir, name)).pipe(
                Effect.map((info) => (info.type === "Directory" ? name : undefined)),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.map((names) => names.filter((name) => name !== undefined)),
      );

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
        writeJsonAtomic(sessionFile(metadata.projectId, metadata.sessionId), metadata).pipe(
          Effect.provide(platform),
        ),

      remove: (projectId, sessionId) =>
        removeFile(sessionFile(projectId, sessionId)).pipe(Effect.provide(platform)),
    };
  }),
);
