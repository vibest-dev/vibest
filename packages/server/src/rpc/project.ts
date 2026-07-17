import "@orpc/experimental-effect/extensions/effect";
import { basename } from "node:path";

import { implement } from "@orpc/server";
import { projectContract } from "@vibest/contract";

import { ProjectService } from "../project";
import type { RpcContext } from "./context";

const orpc = implement(projectContract).$context<RpcContext>();

export const projectRouter = orpc.router({
  create: orpc.create.effect(function* ({ input }) {
    const projects = yield* ProjectService;
    const name = input.name ?? basename(input.path);
    return yield* projects.create({ name, path: input.path });
  }),
  list: orpc.list.effect(function* () {
    const projects = yield* ProjectService;
    return { projects: yield* projects.list() };
  }),
});

export type ProjectRouter = typeof projectRouter;
