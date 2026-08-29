import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { gitContract } from "@vibest/contract/git";
import { Effect } from "effect";

import { GitService } from "../git";
import type { RpcContext } from "./context";

const orpc = implement(gitContract).$context<RpcContext>();

export const gitRouter = orpc.router({
  branch: orpc.branch.effect(function* ({ input }) {
    const git = yield* GitService;
    return yield* git.branch(input.cwd).pipe(
      Effect.map((summary) => ({ current: summary.current ?? null })),
      Effect.catchTag("GitError", () => Effect.succeed({ current: null })),
    );
  }),
});

export type GitRouter = typeof gitRouter;
