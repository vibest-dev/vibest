import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { harnessContract } from "@vibest/contract/harness";
import { Effect } from "effect";

import { HarnessAgentRegistry } from "../harness";
import type { RpcContext } from "./context";

const orpc = implement(harnessContract).$context<RpcContext>();

export const harnessRouter = orpc.router({
  // One-shot negotiation: fold every registered harness's descriptor,
  // availability, and capabilities into a single result the client holds.
  negotiate: orpc.negotiate.effect(function* () {
    const registry = yield* HarnessAgentRegistry;
    const descriptors = yield* registry.list;
    const harnessAgents = yield* Effect.forEach(descriptors, (descriptor) =>
      Effect.gen(function* () {
        // `descriptor.id` came from `registry.list`, so the lookup can't miss.
        const adapter = yield* registry.get(descriptor.id).pipe(Effect.orDie);
        const availability = yield* adapter.checkAvailability;
        const capabilities = yield* adapter.capabilities;
        return {
          id: descriptor.id,
          name: descriptor.name,
          available: availability.available,
          ...(availability.reason ? { reason: availability.reason } : {}),
          capabilities,
        };
      }),
    );
    return { harnessAgents };
  }),
});

export type HarnessRouter = typeof harnessRouter;
