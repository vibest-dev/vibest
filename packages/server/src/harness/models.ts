import path from "node:path";

import type { HarnessAgentId, HarnessModelsInput, HarnessModelsOutput } from "@vibest/contract";
import { Cache, Context, Data, Effect, Exit, FileSystem, Layer } from "effect";

import type { AgentUnavailable, HarnessAgentNotFound } from "./errors";
import { ModelListFailed } from "./errors";
import { HarnessAgentRegistry, type HarnessAgentRegistryShape } from "./registry";

/**
 * Serving what a harness's model providers offer in one working directory, and
 * making sure asking stays cheap.
 *
 * Today every harness carries exactly one built-in provider (its own model
 * catalogue, `providerId === harnessAgentId`); user-configured providers join
 * the same seam later by extending the key → provider resolution below. The cache
 * key is therefore (providerId, cwd) — the unit that will stay correct when a
 * second kind of provider exists.
 *
 * Answering costs a CLI spawn — 0.7s for claude-code, ~3.6s for a cold codex
 * app-server — and it has side effects (the user's SessionStart hooks run). So
 * the price of an answer, not the answer itself, is what this file is about,
 * and `Cache` already has the three properties that matter: concurrent asks for
 * one key share a single lookup, answers are held briefly, and `capacity`
 * bounds the whole thing so a long-lived daemon cannot accumulate an entry per
 * directory it has ever been asked about.
 */

/**
 * Long enough to absorb the burst this is here for — a reload, a second window,
 * a focus refetch — and short enough that editing the directory's own config
 * shows up on the next look rather than the next server restart. It is a
 * de-duplication window, not a claim about how long the answer stays true; the
 * client's `staleTime` is what decides freshness.
 */
const MODELS_TTL = "60 seconds";

/**
 * Failures are deliberately given no lifetime at all. `Cache` stores the
 * lookup's `Exit`, so without this an expired login or one wedged CLI would
 * answer "no models" for the next minute — and the user who just logged back in
 * would have to sit it out for no reason.
 */
const FAILURE_TTL = 0;

/**
 * Far above any real answer (measured: 0.7s / 3.6s). This is the "the CLI is
 * wedged" guard, not a latency budget — nothing is waiting on it to paint, so
 * there is no reason to cut a slow-but-working machine off.
 */
const LIST_TIMEOUT = "30 seconds";

/**
 * Big enough that no real usage pattern evicts anything, small enough that it
 * stays a bound rather than a leak.
 */
const CACHE_CAPACITY = 256;

/** A `Data.Class` because structural equality is what makes it a cache key. */
class ModelsKey extends Data.Class<{
  readonly providerId: HarnessAgentId;
  readonly cwd: string;
}> {}

/**
 * `AgentUnavailable` rides alongside `ModelListFailed` rather than being
 * folded into it: "this harness's CLI is not installed" is a settled fact the
 * client should render as a greyed-out harness, while a failure to read the
 * catalogue is a transient, retryable degraded state. Collapsing the two would
 * make an uninstalled harness look like a server that keeps breaking.
 */
export type HarnessModelsShape = {
  readonly list: (
    input: HarnessModelsInput,
  ) => Effect.Effect<
    HarnessModelsOutput,
    ModelListFailed | AgentUnavailable | HarnessAgentNotFound
  >;
};

export class HarnessModelsService extends Context.Service<
  HarnessModelsService,
  HarnessModelsShape
>()("HarnessModelsService") {}

export const makeHarnessModels = (
  registry: HarnessAgentRegistryShape,
): Effect.Effect<HarnessModelsShape, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    // Bound once here so the service's `list` stays `R`-free for its RPC
    // caller — the requirement comes from the registry's availability gate.
    const platform = yield* Effect.context<FileSystem.FileSystem>();
    // One built-in provider per harness for now, so resolving a providerId is
    // a registry lookup. Never collapse a failure into an empty answer here —
    // the error channel is what keeps "the read failed" distinguishable from
    // "this harness has no models".
    const loadProvider = ({ providerId, cwd }: ModelsKey) =>
      Effect.gen(function* () {
        // `require`, not `get`: asking a harness for its catalogue spawns its
        // CLI, so an absent binary has to stop the call here. Going in on an
        // unchecked adapter is what used to reach claude-code's "the
        // executable vanished after the availability check gated on it"
        // defect — a check this path never performed.
        const adapter = yield* registry.require(providerId).pipe(Effect.provide(platform));
        // No catalogue at all is an answer, not a failure: this harness has
        // none to offer (pi), so the client renders no picker for it.
        if (!adapter.listModels) return { providers: [] } satisfies HarnessModelsOutput;

        const models = yield* adapter.listModels(cwd).pipe(
          Effect.timeoutOrElse({
            duration: LIST_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new ModelListFailed({
                  harnessAgentId: providerId,
                  cause: new Error(`reading the model catalogue timed out after ${LIST_TIMEOUT}`),
                }),
              ),
          }),
        );
        return {
          providers: [{ id: providerId, label: adapter.descriptor.name, models }],
        } satisfies HarnessModelsOutput;
      });

    const cache = yield* Cache.makeWith(loadProvider, {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? MODELS_TTL : FAILURE_TTL),
    });

    return {
      // Resolved on the way in, so `/w/app`, `/w/app/` and `/w/x/../app` are one
      // entry rather than three reads of the same directory.
      list: ({ harnessAgentId, cwd }) =>
        Cache.get(cache, new ModelsKey({ providerId: harnessAgentId, cwd: path.resolve(cwd) })),
    };
  });

export const HarnessModelsLayer: Layer.Layer<
  HarnessModelsService,
  never,
  HarnessAgentRegistry | FileSystem.FileSystem
> = Layer.effect(
  HarnessModelsService,
  Effect.gen(function* () {
    const registry = yield* HarnessAgentRegistry;
    return yield* makeHarnessModels(registry);
  }),
);
