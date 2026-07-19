import { Context, Effect, Layer } from "effect";

import { Paths } from "../config/paths";
import type { StoreReadError, StoreWriteError } from "../errors";
import { readJson, writeJsonAtomic } from "../infra/json-store";
import type { McpServerConfig, RuntimeConfig } from "../types";

/**
 * Data access for the `mcp` field of `$VIBEST_HOME/config.json`. Like
 * ProviderRepository, reads/rewrites the whole config to preserve `provider`.
 */
export class McpRepository extends Context.Service<
  McpRepository,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<McpServerConfig>, StoreReadError>;
    readonly save: (
      servers: ReadonlyArray<McpServerConfig>,
    ) => Effect.Effect<void, StoreReadError | StoreWriteError>;
  }
>()("McpRepository") {}

export const McpRepositoryLayer: Layer.Layer<McpRepository, never, Paths> = Layer.effect(
  McpRepository,
  Effect.gen(function* () {
    const paths = yield* Paths;
    const readConfig = () => readJson<RuntimeConfig>(paths.configStore, {});
    return {
      list: () => readConfig().pipe(Effect.map((config) => config.mcp ?? [])),
      save: (servers) =>
        Effect.gen(function* () {
          const config = yield* readConfig();
          yield* writeJsonAtomic(paths.configStore, {
            ...config,
            mcp: servers,
          });
        }),
    };
  }),
);
