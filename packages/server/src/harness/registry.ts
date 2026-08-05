import type { HarnessAgentId } from "@vibest/contract";
import { Context, Effect, FileSystem, Layer } from "effect";

import type { AgentDescriptor, HarnessAgentAdapter } from "./adapter";
import { AgentUnavailable, HarnessAgentNotFound } from "./errors";

export type HarnessAgentRegistryShape = {
  readonly list: Effect.Effect<ReadonlyArray<AgentDescriptor>>;
  /**
   * The adapter as registered — available or not. For the two callers that
   * must see an unusable harness: `harness.list` renders it greyed out with
   * its reason, and permission-vocabulary validation reads declared values
   * that cost no process. Everything that is about to make the harness *do*
   * something uses {@link HarnessAgentRegistryShape.require} instead.
   */
  readonly get: (
    harnessAgentId: HarnessAgentId,
  ) => Effect.Effect<HarnessAgentAdapter, HarnessAgentNotFound>;
  /**
   * The adapter, guaranteed usable.
   *
   * This is the availability gate, and it lives here so there is exactly one
   * of it. It used to be the caller's homework — `session-manager` did it, the
   * model-list path did not — and the miss was invisible: nothing in the type
   * of `get` said an unchecked adapter was a mistake. A harness whose CLI was
   * absent therefore answered `list` correctly (greyed out) while the
   * model-list route walked straight into the adapter and died on the missing
   * binary, taking the endpoint down every few seconds instead of degrading
   * the one harness.
   *
   * Registered-but-unavailable and not-registered-at-all are one question to
   * every caller here ("can I use this?"), so both errors come out of one
   * call. The `FileSystem` requirement is the adapter's own
   * `checkAvailability` showing through; consumers bind it while building
   * their layer, as they already do.
   */
  readonly require: (
    harnessAgentId: HarnessAgentId,
  ) => Effect.Effect<
    HarnessAgentAdapter,
    HarnessAgentNotFound | AgentUnavailable,
    FileSystem.FileSystem
  >;
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

  const get = (
    harnessAgentId: HarnessAgentId,
  ): Effect.Effect<HarnessAgentAdapter, HarnessAgentNotFound> => {
    const adapter = byId.get(harnessAgentId);
    return adapter
      ? Effect.succeed(adapter)
      : Effect.fail(new HarnessAgentNotFound({ harnessAgentId }));
  };

  return {
    list: Effect.succeed(descriptors),
    get,
    require: (harnessAgentId) =>
      get(harnessAgentId).pipe(
        Effect.flatMap((adapter) =>
          adapter.checkAvailability.pipe(
            Effect.flatMap((availability) =>
              availability.available
                ? Effect.succeed(adapter)
                : Effect.fail(
                    new AgentUnavailable({
                      harnessAgentId,
                      reason: availability.reason ?? "Unavailable",
                    }),
                  ),
            ),
          ),
        ),
      ),
  };
};

export const HarnessAgentRegistryLayer = (
  adapters: ReadonlyArray<HarnessAgentAdapter>,
): Layer.Layer<HarnessAgentRegistry> =>
  Layer.succeed(HarnessAgentRegistry, makeHarnessAgentRegistry(adapters));
