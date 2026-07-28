import { Context, Effect, Layer } from "effect";

import { Paths } from "../config/paths";
import type { StoreReadError, StoreWriteError } from "../errors";
import { readJson, writeJsonAtomic, type JsonStorePlatform } from "../infra/json-store";
import type { ProviderConfig, RuntimeConfig } from "../types";

/**
 * Data access for the `provider` field of `$VIBEST_HOME/config.json`. Reads the
 * whole config object and rewrites it atomically so the sibling `mcp` field is
 * preserved.
 */
export class ProviderRepository extends Context.Service<
  ProviderRepository,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<ProviderConfig>, StoreReadError>;
    readonly save: (
      providers: ReadonlyArray<ProviderConfig>,
    ) => Effect.Effect<void, StoreReadError | StoreWriteError>;
  }
>()("ProviderRepository") {}

export const ProviderRepositoryLayer: Layer.Layer<
  ProviderRepository,
  never,
  Paths | JsonStorePlatform
> = Layer.effect(
  ProviderRepository,
  Effect.gen(function* () {
    const paths = yield* Paths;
    // Bind the platform services once so the methods below stay R-free; the
    // Layer's R carries the requirement to the composition root instead.
    const platform = yield* Effect.context<JsonStorePlatform>();
    const readConfig = () => readJson<RuntimeConfig>(paths.configFile, {});
    return {
      list: () =>
        readConfig().pipe(
          Effect.map((config) => config.provider ?? []),
          Effect.provide(platform),
        ),
      save: (providers) =>
        Effect.gen(function* () {
          const config = yield* readConfig();
          yield* writeJsonAtomic(paths.configFile, {
            ...config,
            provider: providers,
          });
        }).pipe(Effect.provide(platform)),
    };
  }),
);
