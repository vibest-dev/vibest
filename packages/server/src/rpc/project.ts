import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { projectContract } from "@vibest/contract/project";

import { ProjectService } from "../project";
import type { RpcContext } from "./context";
import { translateErrors } from "./error-translation";

const orpc = implement(projectContract).$context<RpcContext>();

// The project contract declares no error vocabulary: its only failures are
// store I/O, which is infrastructure — kept internal by decision, so a new
// ProjectService error forces a mapping decision here.
export const projectRouter = orpc.router({
  list: orpc.list.effect(function* () {
    const projects = yield* ProjectService;
    return yield* translateErrors(projects.list(), { StoreReadError: "internal" });
  }),
  create: orpc.create.effect(function* ({ input }) {
    const projects = yield* ProjectService;
    return yield* translateErrors(projects.create(input), {
      StoreReadError: "internal",
      StoreWriteError: "internal",
    });
  }),
});

export type ProjectRouter = typeof projectRouter;
