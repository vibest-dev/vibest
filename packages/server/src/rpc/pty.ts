import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { ptyContract } from "@vibest/contract/pty";
import { Effect } from "effect";

import { PtyService } from "../pty/service";
import type { RpcContext } from "./context";
import { translateErrors } from "./error-translation";
import { streamToAsyncGenerator } from "./stream";

const orpc = implement(ptyContract).$context<RpcContext>();

export const ptyRouter = orpc.router({
  create: orpc.create.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* translateErrors(ptys.create(input), {
      ProjectNotFound: (error) =>
        Effect.fail(errors.PROJECT_NOT_FOUND({ data: { projectId: error.projectId } })),
      PtyLimitReached: (error) =>
        Effect.fail(
          errors.LIMIT_REACHED({ data: { projectId: error.projectId, limit: error.limit } }),
        ),
      PtySpawnFailed: (error) =>
        Effect.fail(errors.SPAWN_FAILED({ data: { projectId: error.projectId } })),
      StoreReadError: "internal",
    });
  }),
  list: orpc.list.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* translateErrors(ptys.list(input.projectId), {
      ProjectNotFound: (error) =>
        Effect.fail(errors.PROJECT_NOT_FOUND({ data: { projectId: error.projectId } })),
      StoreReadError: "internal",
    });
  }),
  get: orpc.get.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* translateErrors(ptys.get(input.ptyId), {
      PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
    });
  }),
  write: orpc.write.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* translateErrors(ptys.write(input.ptyId, input.data), {
      PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
    });
  }),
  resize: orpc.resize.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* translateErrors(ptys.resize(input.ptyId, input.cols, input.rows), {
      PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
    });
  }),
  delete: orpc.delete.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    return yield* translateErrors(ptys.delete(input.ptyId), {
      PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
    });
  }),
  subscribe: orpc.subscribe.effect(function* ({ input, errors }) {
    const ptys = yield* PtyService;
    const stream = yield* translateErrors(ptys.subscribe(input.ptyId), {
      PtyNotFound: (error) => Effect.fail(errors.NOT_FOUND({ data: { ptyId: error.ptyId } })),
    });
    return streamToAsyncGenerator(stream);
  }),
});

export type PtyRouter = typeof ptyRouter;
