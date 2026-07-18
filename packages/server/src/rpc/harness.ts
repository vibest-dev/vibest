import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { harnessContract } from "@vibest/contract/harness";
import { HarnessAgentRegistry } from "@vibest/harness/runtime";

import type { RpcContext } from "./context";

const orpc = implement(harnessContract).$context<RpcContext>();

export const harnessRouter = orpc.router({
  capabilities: orpc.capabilities.effect(function* ({ input }) {
    const registry = yield* HarnessAgentRegistry;
    const adapter = yield* registry.get(input.harnessAgentId);
    return yield* adapter.capabilities;
  }),
});

export type HarnessRouter = typeof harnessRouter;
