import type { PtyInfo, PtyStreamEvent } from "@vibest/contract";
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect";

import {
  ProjectNotFound,
  PtyLimitReached,
  PtyNotFound,
  PtySpawnFailed,
  type StoreReadError,
} from "../errors";
import { ProjectService } from "../project";
import { PtyManager } from "./manager";

export type PtyServiceShape = {
  readonly create: (input: {
    readonly projectId: string;
    readonly cols: number;
    readonly rows: number;
  }) => Effect.Effect<PtyInfo, ProjectNotFound | PtyLimitReached | PtySpawnFailed | StoreReadError>;
  readonly list: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<PtyInfo>, ProjectNotFound | StoreReadError>;
  readonly get: (ptyId: string) => Effect.Effect<PtyInfo, PtyNotFound>;
  readonly write: (ptyId: string, data: string) => Effect.Effect<void, PtyNotFound>;
  readonly resize: (ptyId: string, cols: number, rows: number) => Effect.Effect<void, PtyNotFound>;
  readonly delete: (ptyId: string) => Effect.Effect<void, PtyNotFound>;
  readonly subscribe: (ptyId: string) => Effect.Effect<Stream.Stream<PtyStreamEvent>, PtyNotFound>;
};

export class PtyService extends Context.Service<PtyService, PtyServiceShape>()("PtyService") {}

export const PtyServiceLayer: Layer.Layer<PtyService, never, PtyManager | ProjectService> =
  Layer.effect(
    PtyService,
    Effect.gen(function* () {
      const ptys = yield* PtyManager;
      const projects = yield* ProjectService;

      return {
        create: (input) =>
          projects.findById(input.projectId).pipe(
            Effect.flatMap((project) =>
              ptys.create({
                projectId: input.projectId,
                cwd: project.path,
                cols: input.cols,
                rows: input.rows,
              }),
            ),
          ),
        list: (projectId) =>
          projects.findById(projectId).pipe(Effect.flatMap(() => ptys.list(projectId))),
        get: (ptyId) => ptys.get(ptyId),
        write: (ptyId, data) => ptys.write(ptyId, data),
        resize: (ptyId, cols, rows) => ptys.resize(ptyId, cols, rows),
        delete: (ptyId) => ptys.delete(ptyId),
        subscribe: (ptyId) =>
          Effect.gen(function* () {
            const subscriptionScope = yield* Scope.make();
            const stream = yield* ptys
              .subscribe(ptyId)
              .pipe(Effect.provideService(Scope.Scope, subscriptionScope));
            return stream.pipe(Stream.ensuring(Scope.close(subscriptionScope, Exit.void)));
          }),
      } satisfies PtyServiceShape;
    }),
  );
