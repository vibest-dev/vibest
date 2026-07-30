import type { HarnessAgentInfo, HarnessListOutput } from "@vibest/contract";
import { Context, Effect, FileSystem, Layer } from "effect";

import { HarnessAgentRegistry, type HarnessAgentRegistryShape } from "./registry";

/**
 * Declaring every harness the server hosts: what it is, whether it can run
 * right now, and which members of vibest's permission vocabulary it honours.
 *
 * All of it is declared. Availability is a PATH lookup and the permission
 * subset is a literal in the adapter, so this cannot fail, has nothing to
 * cache, and returns in well under a millisecond — which is why the client can
 * keep awaiting it before first paint.
 *
 * Anything that needs a CLI to answer belongs to {@link HarnessProbeService}
 * instead. That split is about acquisition cost and failure mode only — it
 * says nothing about who owns the values' meaning (both endpoints can carry
 * normalized and opaque settings, see docs/design/harness-concept-ownership.md).
 */

export type HarnessListShape = {
  readonly list: Effect.Effect<HarnessListOutput>;
};

/** What {@link makeHarnessList} returns before its layer binds the platform. */
type UnboundHarnessList = {
  readonly list: Effect.Effect<HarnessListOutput, never, FileSystem.FileSystem>;
};

export class HarnessListService extends Context.Service<HarnessListService, HarnessListShape>()(
  "HarnessListService",
) {}

export const makeHarnessList = (registry: HarnessAgentRegistryShape): UnboundHarnessList => ({
  list: registry.list.pipe(
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
            permissionModes: adapter.permissionModes,
            ...(adapter.defaultPermissionMode
              ? { defaultPermissionMode: adapter.defaultPermissionMode }
              : {}),
          } satisfies HarnessAgentInfo;
        }),
      ),
    ),
    Effect.map((harnessAgents) => ({ harnessAgents })),
  ),
});

export const HarnessListLayer: Layer.Layer<
  HarnessListService,
  never,
  HarnessAgentRegistry | FileSystem.FileSystem
> = Layer.effect(
  HarnessListService,
  Effect.gen(function* () {
    const registry = yield* HarnessAgentRegistry;
    // Availability is a PATH lookup, so it needs the filesystem. Bind it once
    // here and the service's `list` stays R-free for its RPC caller.
    const platform = yield* Effect.context<FileSystem.FileSystem>();
    const { list } = makeHarnessList(registry);
    return { list: list.pipe(Effect.provide(platform)) };
  }),
);
