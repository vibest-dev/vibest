import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { ptyContract } from "@vibest/contract/pty";
import { Effect } from "effect";

import { PtyService } from "../pty/service";
import type { RpcContext } from "./context";
import { streamToAsyncGenerator } from "./stream";

const orpc = implement(ptyContract).$context<RpcContext>();

export const ptyRouter = orpc.router({
  create: orpc.create.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* ptys.create(input).pipe(
      Effect.catchTags({
        ProjectNotFound: (error) =>
          Effect.fail(errors.PROJECT_NOT_FOUND({ data: { projectId: error.projectId } })),
        PtyLimitReached: (error) =>
          Effect.fail(
            errors.LIMIT_REACHED({ data: { projectId: error.projectId, limit: error.limit } }),
          ),
        PtySpawnFailed: (error) =>
          Effect.fail(errors.SPAWN_FAILED({ data: { projectId: error.projectId } })),
      }),
    );
  }),
  list: orpc.list.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* ptys.list(input.projectId).pipe(
      Effect.catchTags({
        ProjectNotFound: (error) =>
          Effect.fail(errors.PROJECT_NOT_FOUND({ data: { projectId: error.projectId } })),
      }),
    );
  }),
  get: orpc.get.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* ptys.get(input.ptyId).pipe(
      Effect.catchTags({
        PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
      }),
    );
  }),
  write: orpc.write.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* ptys.write(input.ptyId, input.data).pipe(
      Effect.catchTags({
        PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
      }),
    );
  }),
  resize: orpc.resize.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* ptys.resize(input.ptyId, input.cols, input.rows).pipe(
      Effect.catchTags({
        PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
      }),
    );
  }),
  delete: orpc.delete.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* ptys.delete(input.ptyId).pipe(
      Effect.catchTags({
        PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
      }),
    );
  }),
  subscribe: orpc.subscribe.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    const stream = yield* ptys.subscribe(input.ptyId).pipe(
      Effect.catchTags({
        PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
      }),
    );
    return streamToAsyncGenerator(stream);
  }),
});

export type PtyRouter = typeof ptyRouter;
