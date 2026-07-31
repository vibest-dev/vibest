import type { HarnessAgentId } from "@vibest/contract";
import { Context, Effect, Layer } from "effect";

import type { AgentDescriptor, HarnessAgentAdapter } from "./adapter";
import { HarnessAgentNotFound } from "./errors";

export type HarnessAgentRegistryShape = {
  readonly list: Effect.Effect<ReadonlyArray<AgentDescriptor>>;
  readonly get: (
    harnessAgentId: HarnessAgentId,
  ) => Effect.Effect<HarnessAgentAdapter, HarnessAgentNotFound>;
};

export class HarnessAgentRegistry extends Context.Service<
  HarnessAgentRegistry,
  HarnessAgentRegistryShape
>()("HarnessAgentRegistry") {}

export const makeHarnessAgentRegistry = (
  adapters: ReadonlyArray<HarnessAgentAdapter>,
): HarnessAgentRegistryShape => {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const descriptors = Array.from(byId.values(), (adapter) => adapter.descriptor);

  return {
    list: Effect.succeed(descriptors),
    get: (harnessAgentId) => {
      const adapter = byId.get(harnessAgentId);
      return adapter
        ? Effect.succeed(adapter)
        : Effect.fail(new HarnessAgentNotFound({ harnessAgentId }));
    },
  };
};

export const HarnessAgentRegistryLayer = (
  adapters: ReadonlyArray<HarnessAgentAdapter>,
): Layer.Layer<HarnessAgentRegistry> =>
  Layer.succeed(HarnessAgentRegistry, makeHarnessAgentRegistry(adapters));
