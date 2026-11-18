import type { HarnessOption } from "@vibest/plugin/effect"
import { VibestCommand } from "@vibest/schema/layout"
import type { HarnessChoice } from "@vibest/schema/session"
import { HarnessUnavailable } from "@vibest/schema/session"
import { Cache, Clock, Config, Context, Duration, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"

import { LayerNode } from "./effect/layer-node.ts"
import { PlatformNode } from "./effect/platform.ts"
import { Harnesses, unprovided } from "./harnesses.ts"
import { checkSignedIn, listModels, type Model } from "./models.ts"

export * as Harness from "./harness.ts"

export const encodeCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))

export const hasNewline = (args: ReadonlyArray<string>) => args.some((a) => /[\r\n]/.test(a))

export const MODELS_TTL = Duration.minutes(5)
const MODEL_CACHE_CAPACITY = 32

const decodeModelCacheKey = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.String, Schema.String, Schema.Array(Schema.Tuple([Schema.String, Schema.String]))]),
  ),
)

const modelCacheKey = (id: string, provider: string | null, env?: Readonly<Record<string, string>>) =>
  JSON.stringify([
    id,
    provider ?? "",
    Object.entries(env ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ])

export interface Interface {
  readonly available: (id: string) => Effect.Effect<boolean>
  readonly plugin: (id: string) => Effect.Effect<string, HarnessUnavailable>
  readonly signedIn: (id: string, env: Readonly<Record<string, string>>) => Effect.Effect<boolean | undefined>
  readonly models: (
    id: string,
    provider: string | null,
    env?: Readonly<Record<string, string>>,
  ) => Effect.Effect<ReadonlyArray<Model>, HarnessUnavailable>
}

export class Service extends Context.Service<Service, Interface>()("vibest/Harness") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const pinned = Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(
    Context.add(FileSystem.FileSystem, fs),
    Context.add(Path.Path, path),
  )

  const harnesses = yield* Harnesses.Service
  const self = yield* VibestCommand
  const pkg = self.length === 1 && path.isAbsolute(self[0]!) ? path.dirname(path.dirname(self[0]!)) : undefined

  const beside =
    pkg === undefined
      ? undefined
      : yield* Effect.findFirst(
          [
            path.join(pkg, "harnesses"),
            path.join(pkg, "..", "cli", "harnesses"),
            path.join(pkg, "..", "..", "..", "harnesses"),
          ],
          (dir) => fs.exists(dir).pipe(Effect.orElseSucceed(() => false)),
        ).pipe(Effect.map((found) => Option.getOrElse(found, () => path.join(pkg, "harnesses"))))

  const plugins = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_HARNESSES"))) || beside
  const searchPath = (yield* Config.String("PATH").pipe(Config.withDefault(""))).split(":").filter(Boolean)

  const listOf = (key: string) => {
    const [id, providerName, entries] = decodeModelCacheKey(key)
    const definition = harnesses.find(id)

    return definition === undefined
      ? Effect.fail(unprovided(id, harnesses.all))
      : listModels(definition, providerName === "" ? null : providerName, Object.fromEntries(entries)).pipe(
          Effect.provide(pinned),
          Effect.flatMap((models) => Effect.map(Clock.currentTimeMillis, (listedAt) => ({ models, listedAt }))),
        )
  }

  const cached = yield* Cache.makeWith(listOf, {
    capacity: MODEL_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  })

  const signIns = yield* Cache.makeWith(
    (key: string) => {
      const [id, , entries] = decodeModelCacheKey(key)
      const definition = harnesses.find(id)

      return definition === undefined
        ? Effect.succeed(undefined)
        : checkSignedIn(definition, Object.fromEntries(entries)).pipe(Effect.provide(pinned))
    },
    {
      capacity: MODEL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value === true ? MODELS_TTL : Duration.zero),
    },
  )

  const refreshing = new Set<string>()
  const scope = yield* Effect.scope

  const refresh = (key: string) =>
    listOf(key).pipe(
      Effect.matchEffect({
        onSuccess: (listed) => Cache.set(cached, key, listed),
        onFailure: () => Cache.invalidate(cached, key),
      }),
      Effect.ensuring(Effect.sync(() => refreshing.delete(key))),
    )

  return Service.of({
    available: Effect.fn("Harness.available")((id) =>
      Effect.suspend(() => {
        const definition = harnesses.find(id)

        return definition === undefined
          ? Effect.succeed(false)
          : Effect.findFirst(searchPath, (dir) =>
              fs.stat(path.join(dir, definition.binary)).pipe(
                Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
                Effect.orElseSucceed(() => false),
              ),
            ).pipe(Effect.map(Option.isSome))
      }),
    ),
    plugin: Effect.fn("Harness.plugin")(function* (id) {
      const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
      const definition = harnesses.find(id)

      if (definition === undefined) return yield* unprovided(id, harnesses.all)
      const integration = definition.integration ?? id

      if (path.isAbsolute(integration)) return integration

      if (!plugins)
        return yield* unavailable(
          "VIBEST_HARNESSES is not set, and vibest runs from source; set it to a built harnesses/ directory",
        )
      const dir = path.join(plugins, integration)

      if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))))
        return yield* unavailable(`vibest's ${id} plugin is missing: ${dir}`)

      return dir
    }),
    signedIn: (id, env) => Cache.get(signIns, modelCacheKey(id, null, env)),
    models: Effect.fn("Harness.models")(function* (id, provider, env) {
      const key = modelCacheKey(id, provider, env)
      const listed = yield* Cache.get(cached, key)
      const stale = (yield* Clock.currentTimeMillis) - listed.listedAt >= Duration.toMillis(MODELS_TTL)

      if (stale && !refreshing.has(key)) {
        refreshing.add(key)
        yield* Effect.forkIn(refresh(key), scope)
      }

      return listed.models
    }),
  })
})

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Harnesses.node, PlatformNode.childProcessSpawner, PlatformNode.fileSystem, PlatformNode.path],
})

export const startable = Effect.fn("Harness.startable")(function* (id: string, provider: string | null) {
  const harness = yield* Service
  const harnesses = yield* Harnesses.Service
  const adapter = harnesses.find(id)

  if (adapter === undefined) return yield* unprovided(id, harnesses.all)
  const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
  const providerError = adapter.checkProvider?.(provider)

  if (providerError) return yield* unavailable(providerError)

  if (!(yield* harness.available(id))) return yield* unavailable(`${adapter.binary} is not on PATH`)
  yield* harness.plugin(id)
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""), Effect.orDie)
  const problem = yield* adapter.checkEnvironment?.(home) ?? Effect.succeed(undefined)

  if (problem) return yield* unavailable(problem)
})

export const preflight = Effect.fn("Harness.preflight")(function* (
  id: string,
  provider: string | null,
  model: string | null,
  env?: Readonly<Record<string, string>>,
) {
  yield* startable(id, provider)
  const harness = yield* Service
  const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })

  const models = yield* harness
    .models(id, provider, env)
    .pipe(Effect.mapError((e) => unavailable(`${id} model discovery failed: ${e.message}`)))

  if (model !== null && !models.some((m) => m.model === model)) {
    const choices = models.map((m) => (m.provider ? `${m.provider}/${m.model}` : m.model)).join(", ")

    return yield* unavailable(
      `${id} does not list model "${model}"${provider ? ` for provider "${provider}"` : ""}; choose one of: ${choices}`,
    )
  }

  return models
})

export const harnessCatalog = Effect.flatMap(Harnesses.Service, (harnesses) =>
  Effect.forEach(
    harnesses.all,
    ({ id, binary }) =>
      preflight(id, null, null).pipe(
        Effect.map((models): HarnessChoice => ({
          harness: id,
          binary,
          problem: null,
          models: models.map((m) => ({ provider: m.provider, model: m.model, name: m.name, default: m.default })),
        })),
        Effect.catchTag("HarnessUnavailable", (e) =>
          Effect.succeed<HarnessChoice>({ harness: id, binary, problem: e.message, models: [] }),
        ),
      ),
    { concurrency: "unbounded" },
  ),
)

export const startableOptions = Effect.flatMap(Harnesses.Service, (harnesses) =>
  Effect.forEach(
    harnesses.all,
    ({ id }) =>
      startable(id, null).pipe(
        Effect.as<HarnessOption>({ harness: id, available: true }),
        Effect.catchTag("HarnessUnavailable", (e) =>
          Effect.succeed<HarnessOption>({ harness: id, available: false, problem: e.message }),
        ),
      ),
    { concurrency: "unbounded" },
  ),
)

export const harnessOptions = Effect.map(harnessCatalog, (choices) =>
  choices.map((c): HarnessOption =>
    c.problem === null
      ? { harness: c.harness, available: true }
      : { harness: c.harness, available: false, problem: c.problem },
  ),
)
