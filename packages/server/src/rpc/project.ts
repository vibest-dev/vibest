import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { projectContract } from "@vibest/contract/project";

import { ProjectService } from "../project";
import type { RpcContext } from "./context";

const orpc = implement(projectContract).$context<RpcContext>();

// Infallible channels: the project store's failures are defects, reported by
// the defect boundary in rpc/wrap.ts — a new typed ProjectService error would
// surface here as a compile-visible channel to translate.
export const projectRouter = orpc.router({
  list: orpc.list.effect(function* () {
    const projects = yield* ProjectService;
    return yield* projects.list();
  }),
  create: orpc.create.effect(function* ({ input }) {
    const projects = yield* ProjectService;
    return yield* projects.create(input);
  }),
});

export type ProjectRouter = typeof projectRouter;
