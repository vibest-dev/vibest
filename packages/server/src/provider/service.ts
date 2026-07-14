import { Context, Effect, Layer } from "effect";

import type { StoreReadError, StoreWriteError } from "../errors";
import type { ModelInfo, ProviderConfig } from "../types";
import { ProviderRepository } from "./repository";

/**
 * `provider` module: configure providers (built-in overrides + custom) and list
 * them and their models.
 */
export class ProviderService extends Context.Service<
  ProviderService,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<ProviderConfig>, StoreReadError>;
    readonly listModels: (
      providerId?: string,
    ) => Effect.Effect<ReadonlyArray<ModelInfo>, StoreReadError>;
    readonly configure: (
      provider: ProviderConfig,
    ) => Effect.Effect<ProviderConfig, StoreReadError | StoreWriteError>;
  }
>()("ProviderService") {}

export const ProviderServiceLayer: Layer.Layer<ProviderService, never, ProviderRepository> =
  Layer.effect(
    ProviderService,
    Effect.gen(function* () {
      const repo = yield* ProviderRepository;

      return {
        list: () => repo.list(),

        listModels: (providerId) =>
          repo
            .list()
            .pipe(
              Effect.map((providers) =>
                providers
                  .filter((p) => providerId === undefined || p.id === providerId)
                  .flatMap((p) => p.models ?? []),
              ),
            ),

        configure: (provider) =>
          Effect.gen(function* () {
            const providers = yield* repo.list();
            const exists = providers.some((p) => p.id === provider.id);
            const next = exists
              ? providers.map((p) => (p.id === provider.id ? provider : p))
              : [...providers, provider];
            yield* repo.save(next);
            return provider;
          }),
      };
    }),
  );
