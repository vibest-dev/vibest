import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { fsContract } from "@vibest/contract/fs";

import { WorkspaceFSService } from "../fs";
import type { RpcContext } from "./context";

const orpc = implement(fsContract).$context<RpcContext>();

export const fsRouter = orpc.router({
  readFileString: orpc.readFileString.effect(function* ({ input }) {
    const fs = yield* WorkspaceFSService;
    return yield* fs.readFileString(input.cwd, input.path);
  }),
  readDirectory: orpc.readDirectory.effect(function* ({ input }) {
    const fs = yield* WorkspaceFSService;
    return yield* fs.readDirectory(input.cwd, input.path);
  }),
});

export type FsRouter = typeof fsRouter;
