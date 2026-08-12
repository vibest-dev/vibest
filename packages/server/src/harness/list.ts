import type { HarnessAgentInfo, HarnessListOutput } from "@vibest/contract";
import { Context, Effect, FileSystem, Layer } from "effect";

import { HarnessAgentRegistry, type HarnessAgentRegistryShape } from "./registry";

/**
 * Declaring every harness the server hosts: what it is, whether it can run
 * right now, and which members of vibest's permission vocabulary it honours.
 *
 * All of it is declared: the permission subset is a literal in the adapter and
 * availability is a filesystem question, so this cannot fail.
 *
 * It is not free, though, and the client awaits it before first paint:
 * claude-code's check spawns `claude --version` (~45 ms) on every call, and
 * nothing memoizes it. Worth caching per process — see the note in
 * `checkClaudeAvailability`.
 *
 * Anything that needs a CLI to answer belongs to {@link HarnessProbeService}
 * instead. That split is about acquisition cost and failure mode only — it
 * says nothing about who owns the values' meaning (both endpoints can carry
 * normalized and opaque settings, see docs/design/harness-concept-ownership.md).
 */

export type HarnessListShape = {
  readonly list: Effect.Effect<HarnessListOutput>;
};

export class HarnessListService extends Context.Service<HarnessListService, HarnessListShape>()(
  "HarnessListService",
) {}

export const makeHarnessList = (registry: HarnessAgentRegistryShape) => ({
  list: registry.list.pipe(
    Effect.flatMap((descriptors) =>
      Effect.forEach(
        descriptors,
        (descriptor) =>
          Effect.gen(function* () {
            // `descriptor.id` came from `registry.list`, so the lookup can't
            // miss — a miss is a registry invariant violation, not a failure.
            const adapter = yield* registry.get(descriptor.id).pipe(
              Effect.catchTag("HarnessAgentNotFound", (cause) =>
                Effect.die(
                  new Error(`invariant: registry listed '${descriptor.id}' but get missed it`, {
                    cause,
                  }),
                ),
              ),
            );
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
        // The three checks are independent and this RPC blocks the app's first
        // paint; bounded by the registry, so no cap is needed.
        { concurrency: "unbounded" },
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
    // Availability reads the filesystem (and, for claude-code, spawns
    // `claude --version`). Bind the platform once here so the service's `list`
    // stays R-free for its RPC caller.
    const platform = yield* Effect.context<FileSystem.FileSystem>();
    const { list } = makeHarnessList(registry);
    return { list: list.pipe(Effect.provide(platform)) };
  }),
);
