import {
  type PromptPart,
  PromptPartSchema,
  HarnessAgentIdSchema,
  type SessionRecoverySnapshot,
  type SessionRef,
  type SessionScopedEventBody,
} from "@vibest/contract";
import { type JsonStoreLoadError, makeJsonCollection } from "@vibest/effect-json-store";
import { Context, Crypto, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect";

import { Paths } from "../config/paths";
import { StoreReadError, StoreWriteError } from "../errors";
import { RecoveryRequired, StaleRecovery } from "./errors";

const RecoveryPromptSchema = Schema.Struct({
  messageId: Schema.String,
  parts: Schema.Array(PromptPartSchema),
  turnId: Schema.optionalKey(Schema.String),
});

const RecoveryRecordSchema = Schema.Struct({
  recoveryId: Schema.String,
  bootId: Schema.String,
  ref: Schema.Struct({
    projectId: Schema.String,
    harnessAgentId: HarnessAgentIdSchema,
    sessionId: Schema.String,
  }),
  prompts: Schema.Array(RecoveryPromptSchema),
  endedTurnIds: Schema.Array(Schema.String),
});

type RecoveryPrompt = {
  readonly messageId: string;
  readonly parts: ReadonlyArray<PromptPart>;
  readonly turnId?: string;
};

export type SessionRecoveryRecord = {
  readonly recoveryId: string;
  readonly bootId: string;
  readonly ref: SessionRef;
  readonly prompts: ReadonlyArray<RecoveryPrompt>;
  readonly endedTurnIds: ReadonlyArray<string>;
};

export type SessionRecoveryStoreShape = {
  readonly bootId: string;
  readonly read: (ref: SessionRef) => Effect.Effect<SessionRecoveryRecord | null, StoreReadError>;
  readonly barrier: (
    ref: SessionRef,
  ) => Effect.Effect<SessionRecoverySnapshot | null, StoreReadError>;
  readonly requireClear: (
    ref: SessionRef,
  ) => Effect.Effect<void, StoreReadError | RecoveryRequired>;
  readonly beforePublish: (
    ref: SessionRef,
    body: SessionScopedEventBody,
  ) => Effect.Effect<void, StoreReadError | StoreWriteError | RecoveryRequired>;
  readonly acknowledge: (
    ref: SessionRef,
    recoveryId: string,
  ) => Effect.Effect<void, StoreReadError | StoreWriteError | StaleRecovery>;
  readonly clear: (ref: SessionRef) => Effect.Effect<void, StoreWriteError>;
};

export class SessionRecoveryStore extends Context.Service<
  SessionRecoveryStore,
  SessionRecoveryStoreShape
>()("SessionRecoveryStore") {}

const encodeKeySegment = (prefix: string, value: string): string =>
  `${prefix}-${encodeURIComponent(value)}`;
const keyOf = (ref: SessionRef): string =>
  [
    encodeKeySegment("project", ref.projectId),
    encodeKeySegment("harness", ref.harnessAgentId),
    encodeKeySegment("session", ref.sessionId),
  ].join("/");

const snapshotOf = (record: SessionRecoveryRecord): SessionRecoverySnapshot => ({
  recoveryId: record.recoveryId,
  reason: "server_restart",
  prompts: record.prompts,
});

const MAX_ENDED_TURN_IDS = 32;
const appendEndedTurnId = (endedTurnIds: ReadonlyArray<string>, turnId: string): string[] => {
  if (endedTurnIds.includes(turnId)) return Array.from(endedTurnIds);
  return [...endedTurnIds, turnId].slice(-MAX_ENDED_TURN_IDS);
};

export const makeSessionRecoveryStore = (
  directory: string,
  bootId: string,
  newRecoveryId: Effect.Effect<string>,
): Effect.Effect<SessionRecoveryStoreShape, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const records = yield* makeJsonCollection({
      dir: directory,
      schema: RecoveryRecordSchema,
      legacy: { schema: RecoveryRecordSchema, migrate: (record) => record },
    });
    // A read followed by put/remove is one logical update. The collection
    // serializes individual operations; this lock keeps the compound update
    // atomic within the one process that owns this store instance.
    const lock = Semaphore.makeUnsafe(1);
    const asReadError = (error: JsonStoreLoadError) =>
      new StoreReadError({ file: error.file, cause: error });
    const asWriteError = (error: { readonly file: string }) =>
      new StoreWriteError({ file: error.file, cause: error });

    const read = (ref: SessionRef) =>
      records.get(keyOf(ref)).pipe(
        Effect.mapError(asReadError),
        Effect.map((found) => (Option.isSome(found) ? found.value : null)),
      );
    const put = (record: SessionRecoveryRecord) =>
      records.put(keyOf(record.ref), record).pipe(Effect.mapError(asWriteError));
    const removeUnlocked = (ref: SessionRef) =>
      records.remove(keyOf(ref)).pipe(Effect.mapError(asWriteError));
    const clear = (ref: SessionRef) => lock.withPermit(removeUnlocked(ref));

    const modify = <E>(
      ref: SessionRef,
      change: (
        current: SessionRecoveryRecord | null,
      ) => Effect.Effect<SessionRecoveryRecord | null, E>,
    ): Effect.Effect<void, StoreReadError | StoreWriteError | E> =>
      lock.withPermit(
        read(ref).pipe(
          Effect.flatMap(change),
          Effect.flatMap((next) => (next === null ? removeUnlocked(ref) : put(next))),
        ),
      );

    const beforePublish: SessionRecoveryStoreShape["beforePublish"] = (ref, body) => {
      switch (body.type) {
        case "session.prompt.submitted":
          return modify(ref, (current) => {
            if (current !== null && current.bootId !== bootId) {
              return Effect.fail(
                new RecoveryRequired({
                  sessionId: ref.sessionId,
                  recoveryId: current.recoveryId,
                }),
              );
            }
            const existing = current?.prompts.some((prompt) => prompt.messageId === body.messageId);
            if (current !== null) {
              return Effect.succeed(
                existing
                  ? current
                  : {
                      ...current,
                      prompts: [
                        ...current.prompts,
                        { messageId: body.messageId, parts: body.parts },
                      ],
                    },
              );
            }
            return newRecoveryId.pipe(
              Effect.map(
                (recoveryId): SessionRecoveryRecord => ({
                  recoveryId,
                  bootId,
                  ref,
                  prompts: [{ messageId: body.messageId, parts: body.parts }],
                  endedTurnIds: [],
                }),
              ),
            );
          });
        case "session.prompt.accepted":
          return modify(ref, (current) => {
            if (current === null || current.bootId !== bootId) return Effect.succeed(current);
            const prompt = current.prompts.find(
              (candidate) => candidate.messageId === body.messageId,
            );
            if (prompt === undefined) return Effect.succeed(current);
            if (current.endedTurnIds.includes(body.turnId)) {
              const prompts = current.prompts.filter(
                (candidate) => candidate.messageId !== body.messageId,
              );
              return Effect.succeed(prompts.length === 0 ? null : { ...current, prompts });
            }
            return Effect.succeed({
              ...current,
              prompts: current.prompts.map((candidate) =>
                candidate.messageId === body.messageId
                  ? { ...candidate, turnId: body.turnId }
                  : candidate,
              ),
            });
          });
        case "session.prompt.rejected":
          return modify(ref, (current) => {
            if (current === null || current.bootId !== bootId) return Effect.succeed(current);
            const prompts = current.prompts.filter((prompt) => prompt.messageId !== body.messageId);
            return Effect.succeed(prompts.length === 0 ? null : { ...current, prompts });
          });
        case "session.turn.ended":
          return modify(ref, (current) => {
            if (current === null || current.bootId !== bootId) return Effect.succeed(current);
            const prompts = current.prompts.filter((prompt) => prompt.turnId !== body.turnId);
            if (prompts.length === 0) return Effect.succeed(null);
            return Effect.succeed({
              ...current,
              prompts,
              endedTurnIds: appendEndedTurnId(current.endedTurnIds, body.turnId),
            });
          });
        case "session.crashed":
          return modify(ref, (current) =>
            current?.bootId === bootId ? Effect.succeed(null) : Effect.succeed(current),
          );
        default:
          return Effect.void;
      }
    };

    return {
      bootId,
      read,
      barrier: (ref) =>
        read(ref).pipe(
          Effect.map((record) =>
            record !== null && record.bootId !== bootId ? snapshotOf(record) : null,
          ),
        ),
      requireClear: (ref) =>
        read(ref).pipe(
          Effect.flatMap((record) =>
            record !== null && record.bootId !== bootId
              ? Effect.fail(
                  new RecoveryRequired({
                    sessionId: ref.sessionId,
                    recoveryId: record.recoveryId,
                  }),
                )
              : Effect.void,
          ),
        ),
      beforePublish,
      acknowledge: (ref, recoveryId) =>
        lock.withPermit(
          Effect.gen(function* () {
            const record = yield* read(ref);
            if (record === null || record.bootId === bootId || record.recoveryId !== recoveryId) {
              return yield* Effect.fail(
                new StaleRecovery({ sessionId: ref.sessionId, recoveryId }),
              );
            }
            yield* removeUnlocked(ref);
          }),
        ),
      clear,
    } satisfies SessionRecoveryStoreShape;
  });

export const SessionRecoveryStoreLayer: Layer.Layer<
  SessionRecoveryStore,
  never,
  Paths | Crypto.Crypto | FileSystem.FileSystem
> = Layer.effect(
  SessionRecoveryStore,
  Effect.gen(function* () {
    const paths = yield* Paths;
    const crypto = yield* Crypto.Crypto;
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.die(new Error("invariant: platform RNG failed minting a recovery id", { cause })),
      ),
    );
    const bootId = yield* randomId;
    return yield* makeSessionRecoveryStore(paths.sessionRecoveryDir, bootId, randomId);
  }),
);
