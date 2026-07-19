import { join } from "node:path";

import type { SessionRecord } from "@vibest/contract";
import { Context, Effect, Layer } from "effect";

import { Paths } from "../config/paths";
import type { StoreReadError, StoreWriteError } from "../errors";
import { readJson, readJsonDir, removeFile, writeJsonAtomic } from "../infra/json-store";

/**
 * Data access for the session record tree at
 * `$VIBEST_HOME/storage/sessions/<projectId>/<sessionId>.json` — one file per
 * session, no business rules. This is vibest's authoritative session list and
 * doubles as the internal-id → backend-id map (via `harnessSessionId`).
 */
export class SessionRepository extends Context.Service<
  SessionRepository,
  {
    readonly list: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<SessionRecord>, StoreReadError>;
    readonly get: (
      projectId: string,
      sessionId: string,
    ) => Effect.Effect<SessionRecord | undefined, StoreReadError>;
    readonly save: (record: SessionRecord) => Effect.Effect<void, StoreWriteError>;
    readonly remove: (projectId: string, sessionId: string) => Effect.Effect<void, StoreWriteError>;
  }
>()("SessionRepository") {}

export const SessionRepositoryLayer: Layer.Layer<SessionRepository, never, Paths> = Layer.effect(
  SessionRepository,
  Effect.gen(function* () {
    const paths = yield* Paths;
    const fileFor = (projectId: string, sessionId: string) =>
      join(paths.sessionsDir, projectId, `${sessionId}.json`);

    return {
      list: (projectId) => readJsonDir<SessionRecord>(join(paths.sessionsDir, projectId)),
      get: (projectId, sessionId) =>
        readJson<SessionRecord | undefined>(fileFor(projectId, sessionId), undefined),
      save: (record) => writeJsonAtomic(fileFor(record.projectId, record.sessionId), record),
      remove: (projectId, sessionId) => removeFile(fileFor(projectId, sessionId)),
    };
  }),
);
