import path from "node:path";

import type { HarnessAgentId, HarnessProbeInput, HarnessProbeOutput } from "@vibest/contract";
import { Cache, Context, Data, Effect, Exit, Layer } from "effect";

import { CapabilityProbeFailed } from "./errors";
import { HarnessAgentRegistry, type HarnessAgentRegistryShape } from "./registry";

/**
 * Serving what a harness's model providers offer in one working directory, and
 * making sure asking stays cheap.
 *
 * Today every harness carries exactly one built-in provider (its own model
 * catalogue, `providerId === harnessAgentId`); user-configured providers join
 * the same seam later by extending the key → probe resolution below. The cache
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
const PROBE_TTL = "60 seconds";

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
class ProbeKey extends Data.Class<{
  readonly providerId: HarnessAgentId;
  readonly cwd: string;
}> {}

export type HarnessProbeShape = {
  readonly probe: (
    input: HarnessProbeInput,
  ) => Effect.Effect<HarnessProbeOutput, CapabilityProbeFailed>;
};

export class HarnessProbeService extends Context.Service<HarnessProbeService, HarnessProbeShape>()(
  "HarnessProbeService",
) {}

export const makeHarnessProbe = (
  registry: HarnessAgentRegistryShape,
): Effect.Effect<HarnessProbeShape> =>
  Effect.gen(function* () {
    // One built-in provider per harness for now, so resolving a providerId is
    // a registry lookup. Never collapse a failure into an empty answer here —
    // the error channel is what keeps "probe failed" distinguishable from
    // "this harness has no models".
    const probeProvider = ({ providerId, cwd }: ProbeKey) =>
      Effect.gen(function* () {
        const adapter = yield* registry
          .get(providerId)
          .pipe(
            Effect.mapError(
              (cause) => new CapabilityProbeFailed({ harnessAgentId: providerId, cause }),
            ),
          );
        // No probe at all is an answer, not a failure: this harness has no
        // model catalogue (pi), so the client renders no picker for it.
        if (!adapter.probeModels) return { providers: [] } satisfies HarnessProbeOutput;

        const models = yield* adapter.probeModels(cwd).pipe(
          Effect.timeoutOrElse({
            duration: PROBE_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new CapabilityProbeFailed({
                  harnessAgentId: providerId,
                  cause: new Error(`model probe timed out after ${PROBE_TIMEOUT}`),
                }),
              ),
          }),
        );
        return {
          providers: [{ id: providerId, label: adapter.descriptor.name, models }],
        } satisfies HarnessProbeOutput;
      });

    const cache = yield* Cache.makeWith(probeProvider, {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROBE_TTL : FAILURE_TTL),
    });

    return {
      // Resolved on the way in, so `/w/app`, `/w/app/` and `/w/x/../app` are one
      // entry rather than three probes of the same directory.
      probe: ({ harnessAgentId, cwd }) =>
        Cache.get(cache, new ProbeKey({ providerId: harnessAgentId, cwd: path.resolve(cwd) })),
    };
  });

export const HarnessProbeLayer: Layer.Layer<HarnessProbeService, never, HarnessAgentRegistry> =
  Layer.effect(
    HarnessProbeService,
    Effect.gen(function* () {
      const registry = yield* HarnessAgentRegistry;
      return yield* makeHarnessProbe(registry);
    }),
  );
