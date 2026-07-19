import { Context, Effect, Layer } from "effect";

import { Paths } from "../config/paths";
import type { StoreReadError, StoreWriteError } from "../errors";
import { readJson, writeJsonAtomic } from "../infra/json-store";
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

export const ProviderRepositoryLayer: Layer.Layer<ProviderRepository, never, Paths> = Layer.effect(
  ProviderRepository,
  Effect.gen(function* () {
    const paths = yield* Paths;
    const readConfig = () => readJson<RuntimeConfig>(paths.configStore, {});
    return {
      list: () => readConfig().pipe(Effect.map((config) => config.provider ?? [])),
      save: (providers) =>
        Effect.gen(function* () {
          const config = yield* readConfig();
          yield* writeJsonAtomic(paths.configStore, {
            ...config,
            provider: providers,
          });
        }),
    };
  }),
);
