import { Context, Effect, Layer } from "effect";

import type {
  ModelInfo,
  ModelSelection,
  ProviderConfig,
  ResolvedModelConfig,
} from "../types/index.js";

import {
  ModelSelectionUnresolvable,
  ProviderNotFound,
  type StoreReadError,
  type StoreWriteError,
} from "../errors.js";
import { ProviderRepository } from "./repository.js";

/**
 * `provider` module: configure providers (built-in overrides + custom), list
 * them and their models, and resolve a `ModelSelection` into a
 * `ResolvedModelConfig` for an adapter to consume.
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
    readonly resolve: (
      selection: ModelSelection,
    ) => Effect.Effect<
      ResolvedModelConfig,
      StoreReadError | ProviderNotFound | ModelSelectionUnresolvable
    >;
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

        resolve: (selection) =>
          Effect.gen(function* () {
            const providers = yield* repo.list();
            const provider = providers.find((p) => p.id === selection.providerId);
            if (provider === undefined) {
              return yield* Effect.fail(new ProviderNotFound({ providerId: selection.providerId }));
            }
            if (!provider.enabled) {
              return yield* Effect.fail(
                new ModelSelectionUnresolvable({
                  providerId: selection.providerId,
                  modelId: selection.modelId,
                  reason: "provider is disabled",
                }),
              );
            }
            const resolved: ResolvedModelConfig = {
              model: selection.modelId,
              provider: provider.id,
              baseURL: provider.baseURL,
              authToken: provider.apiKey,
            };
            return resolved;
          }),
      };
    }),
  );
