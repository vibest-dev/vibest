import type { HarnessAgentInfo, HarnessNegotiation } from "@vibest/contract";
import { Context, Effect, Layer } from "effect";

import { HarnessAgentRegistry, type HarnessAgentRegistryShape } from "./registry";

/**
 * Declaring every harness the server hosts: what it is, whether it can run
 * right now, and what its permission vocabulary is.
 *
 * All of it is static. Availability is a PATH lookup and capabilities are a
 * literal in the adapter, so this cannot fail, has nothing to cache, and
 * returns in well under a millisecond — which is why the client can keep
 * awaiting it before first paint.
 *
 * Anything that needs a CLI to answer belongs to {@link HarnessAgentCatalogService}
 * instead. That split is not about cost: a harness's model list genuinely
 * differs per working directory (a project's `.claude/settings.json` can remap
 * what an id resolves to), so there is no single answer for this call to give.
 */

export type HarnessNegotiationShape = {
  readonly negotiate: Effect.Effect<HarnessNegotiation>;
};

export class HarnessNegotiationService extends Context.Service<
  HarnessNegotiationService,
  HarnessNegotiationShape
>()("HarnessNegotiationService") {}

export const makeHarnessNegotiation = (
  registry: HarnessAgentRegistryShape,
): HarnessNegotiationShape => ({
  negotiate: registry.list.pipe(
    Effect.flatMap((descriptors) =>
      Effect.forEach(descriptors, (descriptor) =>
        Effect.gen(function* () {
          // `descriptor.id` came from `registry.list`, so the lookup can't miss.
          const adapter = yield* registry.get(descriptor.id).pipe(Effect.orDie);
          const availability = yield* adapter.checkAvailability;
          return {
            id: descriptor.id,
            name: descriptor.name,
            available: availability.available,
            ...(availability.reason ? { reason: availability.reason } : {}),
            // Declared even when the CLI is missing: the picker shows the
            // harness greyed out with its reason, and the reason it can't be
            // used has nothing to do with what it would be able to do.
            capabilities: adapter.capabilities,
          } satisfies HarnessAgentInfo;
        }),
      ),
    ),
    Effect.map((harnessAgents) => ({ harnessAgents })),
  ),
});

export const HarnessNegotiationLayer: Layer.Layer<
  HarnessNegotiationService,
  never,
  HarnessAgentRegistry
> = Layer.effect(
  HarnessNegotiationService,
  Effect.gen(function* () {
    const registry = yield* HarnessAgentRegistry;
    return makeHarnessNegotiation(registry);
  }),
);
