import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { projectContract } from "@vibest/contract/project";

import { ProjectService } from "../project";
import type { RpcContext } from "./context";

const orpc = implement(projectContract).$context<RpcContext>();

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
