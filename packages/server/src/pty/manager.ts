import type { PtyInfo, PtyStreamEvent } from "@vibest/contract";
import {
  Cause,
  Context,
  Crypto,
  Effect,
  Layer,
  Queue,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";

import { PtyLimitReached, PtyNotFound, PtySpawnFailed } from "../errors";
import { defaultShell, ptyTitle, PtySpawner, type PtySpawnerShape, type SpawnedPty } from "./types";

export const PTY_GLOBAL_LIMIT = 32;
export const PTY_PROJECT_LIMIT = 8;

export type PtyCreateInput = {
  readonly projectId: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
};

type SubscriberQueue = Queue.Queue<PtyStreamEvent, Cause.Done>;

type PtyEntry = {
  info: PtyInfo;
  readonly process: SpawnedPty;
  readonly subscribers: Set<SubscriberQueue>;
  unsubscribe: () => void;
  exitCode: number | undefined;
};

export type PtyManagerShape = {
  readonly create: (
    input: PtyCreateInput,
  ) => Effect.Effect<PtyInfo, PtyLimitReached | PtySpawnFailed>;
  readonly list: (projectId: string) => Effect.Effect<ReadonlyArray<PtyInfo>>;
  readonly get: (ptyId: string) => Effect.Effect<PtyInfo, PtyNotFound>;
  readonly write: (ptyId: string, data: string) => Effect.Effect<void, PtyNotFound>;
  readonly resize: (ptyId: string, cols: number, rows: number) => Effect.Effect<void, PtyNotFound>;
  readonly delete: (ptyId: string) => Effect.Effect<void, PtyNotFound>;
  readonly subscribe: (
    ptyId: string,
  ) => Effect.Effect<Stream.Stream<PtyStreamEvent>, PtyNotFound, Scope.Scope>;
};

export class PtyManager extends Context.Service<PtyManager, PtyManagerShape>()("PtyManager") {}

const clampSize = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(512, Math.max(2, Math.trunc(value)));
};

const endQueue = (queue: SubscriberQueue): void => {
  Effect.runFork(Queue.end(queue).pipe(Effect.ignore));
};
const broadcast = (entry: PtyEntry, event: PtyStreamEvent): void => {
  for (const queue of entry.subscribers) {
    Effect.runFork(Queue.offer(queue, event));
  }
  if (event.type === "exit") {
    for (const queue of entry.subscribers) {
      endQueue(queue);
    }
    entry.subscribers.clear();
  }
};

export const makePtyManager = (
  spawner: PtySpawnerShape,
  newId: Effect.Effect<string>,
): Effect.Effect<PtyManagerShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const entries = yield* SynchronizedRef.make<ReadonlyMap<string, PtyEntry>>(new Map());

    const killAll = SynchronizedRef.get(entries).pipe(
      Effect.flatMap((current) =>
        Effect.sync(() => {
          for (const entry of current.values()) {
            entry.unsubscribe();
            entry.process.kill();
            for (const queue of entry.subscribers) {
              endQueue(queue);
            }
            entry.subscribers.clear();
          }
        }),
      ),
      Effect.andThen(SynchronizedRef.set(entries, new Map())),
    );

    yield* Scope.addFinalizer(ownerScope, killAll);

    const create: PtyManagerShape["create"] = (input) =>
      SynchronizedRef.modifyEffect(entries, (current) =>
        Effect.gen(function* () {
          if (current.size >= PTY_GLOBAL_LIMIT) {
            return yield* Effect.fail(
              new PtyLimitReached({ projectId: input.projectId, limit: PTY_GLOBAL_LIMIT }),
            );
          }
          let projectCount = 0;
          for (const entry of current.values()) {
            if (entry.info.projectId === input.projectId) projectCount += 1;
          }
          if (projectCount >= PTY_PROJECT_LIMIT) {
            return yield* Effect.fail(
              new PtyLimitReached({ projectId: input.projectId, limit: PTY_PROJECT_LIMIT }),
            );
          }

          const ptyId = yield* newId;
          const cols = clampSize(input.cols, 80);
          const rows = clampSize(input.rows, 24);
          const shell = defaultShell();
          const spawned = yield* spawner.spawn({
            projectId: input.projectId,
            cwd: input.cwd,
            cols,
            rows,
            shell,
          });
          const info: PtyInfo = {
            ptyId,
            projectId: input.projectId,
            title: ptyTitle(shell, ptyId),
            cols,
            rows,
          };
          const entry: PtyEntry = {
            info,
            process: spawned,
            subscribers: new Set(),
            unsubscribe: () => {},
            exitCode: undefined,
          };
          entry.unsubscribe = spawned.subscribe(
            (data) => broadcast(entry, { type: "data", data }),
            (exitCode) => {
              entry.exitCode = exitCode;
              broadcast(entry, { type: "exit", exitCode });
            },
          );
          return [info, new Map(current).set(ptyId, entry)] as const;
        }),
      );

    const lookup = (ptyId: string): Effect.Effect<PtyEntry, PtyNotFound> =>
      SynchronizedRef.get(entries).pipe(
        Effect.flatMap((current) => {
          const entry = current.get(ptyId);
          return entry === undefined
            ? Effect.fail(new PtyNotFound({ ptyId }))
            : Effect.succeed(entry);
        }),
      );

    return {
      create,
      list: (projectId) =>
        SynchronizedRef.get(entries).pipe(
          Effect.map((current) =>
            [...current.values()]
              .filter((entry) => entry.info.projectId === projectId)
              .map((entry) => entry.info),
          ),
        ),
      get: (ptyId) => lookup(ptyId).pipe(Effect.map((entry) => entry.info)),
      write: (ptyId, data) =>
        lookup(ptyId).pipe(
          Effect.map((entry) => {
            if (entry.exitCode !== undefined) return;
            entry.process.write(data);
          }),
        ),
      resize: (ptyId, cols, rows) =>
        lookup(ptyId).pipe(
          Effect.map((entry) => {
            if (entry.exitCode !== undefined) return;
            const nextCols = clampSize(cols, entry.info.cols);
            const nextRows = clampSize(rows, entry.info.rows);
            entry.process.resize(nextCols, nextRows);
            entry.info = { ...entry.info, cols: nextCols, rows: nextRows };
          }),
        ),
      delete: (ptyId) =>
        SynchronizedRef.modifyEffect(entries, (current) => {
          const entry = current.get(ptyId);
          if (entry === undefined) {
            return Effect.fail(new PtyNotFound({ ptyId }));
          }
          entry.unsubscribe();
          entry.process.kill();
          for (const queue of entry.subscribers) {
            endQueue(queue);
          }
          entry.subscribers.clear();
          const next = new Map(current);
          next.delete(ptyId);
          return Effect.succeed([undefined, next] as const);
        }),
      subscribe: (ptyId) =>
        Effect.gen(function* () {
          const entry = yield* lookup(ptyId);
          const queue = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const output = yield* Queue.unbounded<PtyStreamEvent, Cause.Done>();
              if (entry.exitCode !== undefined) {
                yield* Queue.offer(output, { type: "exit", exitCode: entry.exitCode });
                yield* Queue.end(output);
                return output;
              }
              entry.subscribers.add(output);
              return output;
            }),
            (output) =>
              Effect.sync(() => {
                entry.subscribers.delete(output);
                endQueue(output);
              }),
          );
          return Stream.fromQueue(queue);
        }),
    } satisfies PtyManagerShape;
  });

export const PtyManagerLayer = Layer.effect(
  PtyManager,
  Effect.gen(function* () {
    const spawner = yield* PtySpawner;
    const crypto = yield* Crypto.Crypto;
    const newId = crypto.randomUUIDv4.pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.die(new Error("invariant: platform RNG failed minting a pty id", { cause })),
      ),
    );
    return yield* makePtyManager(spawner, newId);
  }),
);
