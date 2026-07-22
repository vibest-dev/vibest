import path from "node:path";

import type { HarnessAgentCatalog, HarnessAgentId } from "@vibest/contract";
import { Cache, Context, Data, Effect, Exit, Layer } from "effect";

import { CapabilityProbeFailed } from "./errors";
import { HarnessAgentRegistry, type HarnessAgentRegistryShape } from "./registry";

/**
 * Serving a harness's runtime catalog (today: its models) for one working
 * directory, and making sure asking for it stays cheap.
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
const CATALOG_TTL = "60 seconds";

/**
 * Failures are deliberately given no lifetime at all. `Cache` stores the
 * lookup's `Exit`, so without this an expired login or one wedged CLI would
 * answer "no models" for the next minute — and the user who just logged back in
 * would have to sit it out for no reason.
 */
const FAILURE_TTL = 0;

/**
 * Far above any real probe (measured: 0.7s / 3.6s). This is the "the CLI is
 * wedged" guard, not a latency budget — nothing is waiting on it to paint, so
 * there is no reason to cut a slow-but-working machine off.
 */
const PROBE_TIMEOUT = "30 seconds";

/**
 * Big enough that no real usage pattern evicts anything, small enough that it
 * stays a bound rather than a leak.
 */
const CACHE_CAPACITY = 256;

/** A `Data.Class` because structural equality is what makes it a cache key. */
class CatalogKey extends Data.Class<{
  readonly harnessAgentId: HarnessAgentId;
  readonly cwd: string;
}> {}

export type HarnessAgentCatalogShape = {
  readonly get: (input: {
    readonly harnessAgentId: HarnessAgentId;
    readonly cwd: string;
  }) => Effect.Effect<HarnessAgentCatalog, CapabilityProbeFailed>;
};

export class HarnessAgentCatalogService extends Context.Service<
  HarnessAgentCatalogService,
  HarnessAgentCatalogShape
>()("HarnessAgentCatalogService") {}

export const makeHarnessAgentCatalog = (
  registry: HarnessAgentRegistryShape,
): Effect.Effect<HarnessAgentCatalogShape> =>
  Effect.gen(function* () {
    const probe = ({ harnessAgentId, cwd }: CatalogKey) =>
      Effect.gen(function* () {
        const adapter = yield* registry
          .get(harnessAgentId)
          .pipe(Effect.mapError((cause) => new CapabilityProbeFailed({ harnessAgentId, cause })));
        // No probe at all is an answer, not a failure: this harness has no
        // runtime catalog (pi), so the client renders no picker for it.
        if (!adapter.probeCatalog) return {} satisfies HarnessAgentCatalog;

        return yield* adapter.probeCatalog(cwd).pipe(
          Effect.timeoutOrElse({
            duration: PROBE_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new CapabilityProbeFailed({
                  harnessAgentId,
                  cause: new Error(`catalog probe timed out after ${PROBE_TIMEOUT}`),
                }),
              ),
          }),
        );
      });

    const cache = yield* Cache.makeWith(probe, {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? CATALOG_TTL : FAILURE_TTL),
    });

    return {
      // Resolved on the way in, so `/w/app`, `/w/app/` and `/w/x/../app` are one
      // entry rather than three probes of the same directory.
      get: ({ harnessAgentId, cwd }) =>
        Cache.get(cache, new CatalogKey({ harnessAgentId, cwd: path.resolve(cwd) })),
    };
  });

export const HarnessAgentCatalogLayer: Layer.Layer<
  HarnessAgentCatalogService,
  never,
  HarnessAgentRegistry
> = Layer.effect(
  HarnessAgentCatalogService,
  Effect.gen(function* () {
    const registry = yield* HarnessAgentRegistry;
    return yield* makeHarnessAgentCatalog(registry);
  }),
);
