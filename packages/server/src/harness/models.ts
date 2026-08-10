import path from "node:path";

import type {
  HarnessAgentId,
  HarnessGetDefaultModelInput,
  HarnessGetDefaultModelOutput,
  HarnessListModelsInput,
  HarnessListModelsOutput,
} from "@vibest/contract";
import { Cache, Context, Data, Effect, Exit, Layer } from "effect";

import { DefaultModelFailed, ModelListFailed } from "./errors";
import { HarnessAgentRegistry, type HarnessAgentRegistryShape } from "./registry";
import {
  HarnessAgentSessionManager,
  type HarnessAgentSessionManagerShape,
} from "./session-manager";

/**
 * Lists the models one harness can run, preferring an existing session runtime
 * and using a cached directory query only when no suitable runtime is alive.
 */

const MODEL_LIST_TTL = "60 seconds";
const FAILURE_TTL = 0;
const MODEL_LIST_TIMEOUT = "30 seconds";
const CACHE_CAPACITY = 256;

class ModelListKey extends Data.Class<{
  readonly harnessAgentId: HarnessAgentId;
  readonly cwd: string;
}> {}

export type HarnessModelShape = {
  readonly listModels: (
    input: HarnessListModelsInput,
  ) => Effect.Effect<HarnessListModelsOutput, ModelListFailed>;
  readonly getDefaultModel: (
    input: HarnessGetDefaultModelInput,
  ) => Effect.Effect<HarnessGetDefaultModelOutput, DefaultModelFailed>;
};

export class HarnessModelService extends Context.Service<HarnessModelService, HarnessModelShape>()(
  "HarnessModelService",
) {}

export const makeHarnessModels = (
  registry: HarnessAgentRegistryShape,
  manager: HarnessAgentSessionManagerShape,
): Effect.Effect<HarnessModelShape> =>
  Effect.gen(function* () {
    const listFromDirectory = ({ harnessAgentId, cwd }: ModelListKey) =>
      Effect.gen(function* () {
        const adapter = yield* registry
          .get(harnessAgentId)
          .pipe(Effect.mapError((cause) => new ModelListFailed({ harnessAgentId, cause })));
        if (!adapter.listModelProviders) {
          return { providers: [] } satisfies HarnessListModelsOutput;
        }
        const providers = yield* adapter.listModelProviders(cwd).pipe(
          Effect.timeoutOrElse({
            duration: MODEL_LIST_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new ModelListFailed({
                  harnessAgentId,
                  cause: new Error(`model listing timed out after ${MODEL_LIST_TIMEOUT}`),
                }),
              ),
          }),
        );
        return { providers } satisfies HarnessListModelsOutput;
      });

    const directoryCache = yield* Cache.makeWith(listFromDirectory, {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? MODEL_LIST_TTL : FAILURE_TTL),
    });
    const resolveDefaultModel = (harnessAgentId: HarnessAgentId, cwd: string) =>
      registry.get(harnessAgentId).pipe(
        Effect.mapError((cause) => new DefaultModelFailed({ harnessAgentId, cause })),
        Effect.flatMap((adapter) => adapter.getDefaultModel(cwd)),
        Effect.timeoutOrElse({
          duration: MODEL_LIST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new DefaultModelFailed({
                harnessAgentId,
                cause: new Error(`default model resolution timed out after ${MODEL_LIST_TIMEOUT}`),
              }),
            ),
        }),
      );

    const key = (harnessAgentId: HarnessAgentId, cwd: string) =>
      new ModelListKey({ harnessAgentId, cwd: path.resolve(cwd) });
    const cachedDirectoryList = (harnessAgentId: HarnessAgentId, cwd: string) =>
      Cache.get(directoryCache, key(harnessAgentId, cwd));

    return {
      listModels: ({ harnessAgentId, cwd, ref }) =>
        Effect.gen(function* () {
          if (ref) {
            if (ref.harnessAgentId !== harnessAgentId) {
              return yield* new ModelListFailed({
                harnessAgentId,
                cause: new Error(
                  `session ${ref.sessionId} belongs to ${ref.harnessAgentId}, not ${harnessAgentId}`,
                ),
              });
            }
            const runtime = yield* manager.peek(ref);
            if (runtime) {
              if (runtime.listModelProviders) {
                const providers = yield* runtime.listModelProviders.pipe(
                  Effect.mapError((cause) => new ModelListFailed({ harnessAgentId, cause })),
                  Effect.timeoutOrElse({
                    duration: MODEL_LIST_TIMEOUT,
                    orElse: () =>
                      Effect.fail(
                        new ModelListFailed({
                          harnessAgentId,
                          cause: new Error(
                            `live model listing timed out after ${MODEL_LIST_TIMEOUT}`,
                          ),
                        }),
                      ),
                  }),
                );
                return { providers } satisfies HarnessListModelsOutput;
              }
            }
          }

          return yield* cachedDirectoryList(harnessAgentId, cwd);
        }),
      getDefaultModel: ({ harnessAgentId, cwd }) =>
        resolveDefaultModel(harnessAgentId, path.resolve(cwd)),
    } satisfies HarnessModelShape;
  });

export const HarnessModelLayer: Layer.Layer<
  HarnessModelService,
  never,
  HarnessAgentRegistry | HarnessAgentSessionManager
> = Layer.effect(
  HarnessModelService,
  Effect.gen(function* () {
    const registry = yield* HarnessAgentRegistry;
    const manager = yield* HarnessAgentSessionManager;
    return yield* makeHarnessModels(registry, manager);
  }),
);
