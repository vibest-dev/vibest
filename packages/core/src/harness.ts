import type { HarnessOption } from "@vibest/plugin/effect"
import { VibestCommand } from "@vibest/schema/layout"
import type { HarnessChoice } from "@vibest/schema/session"
import { addPluginHint, HarnessUnavailable } from "@vibest/schema/session"
import { Cache, Config, Context, Duration, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"

import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"
import { listModels, type Model } from "./models.ts"
import type { HarnessDefinition, HarnessesShape } from "./plugin/domains.ts"
import * as Registry from "./plugin/registry.ts"
export const encodeCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))

export const unprovided = (id: string, loaded: ReadonlyArray<HarnessDefinition>) =>
  new HarnessUnavailable({
    harness: id,
    message: `no plugin provides harness ${id}; loaded: ${loaded.map((definition) => definition.id).join(", ") || "none"}; ${addPluginHint}`,
  })

export const makeHarnesses: Effect.Effect<HarnessesShape> = Effect.sync(() => {
  const registry = Registry.definitions<HarnessDefinition>("harness")
  const find = (id: string | null | undefined) =>
    id ? registry.get().find((definition) => definition.id === id) : undefined
  return {
    get all() {
      return registry.get()
    },
    get: (id) =>
      Effect.suspend(() => {
        const found = find(id)
        return found === undefined ? Effect.fail(unprovided(id, registry.get())) : Effect.succeed(found)
      }),
    find,
    transform: registry.transform,
  }
})

export class Harnesses extends Context.Service<Harnesses, HarnessesShape>()("vibest/Harnesses") {
  static readonly layer = Layer.effect(Harnesses, makeHarnesses)

  static readonly node = LayerNode.make({ service: Harnesses, layer: Harnesses.layer, deps: [] })
}

export const hasNewline = (args: ReadonlyArray<string>) => args.some((a) => /[\r\n]/.test(a))

export const MODELS_TTL = Duration.minutes(5)
const MODEL_CACHE_CAPACITY = 32

const modelCacheKey = (id: string, provider: string | null, env?: Readonly<Record<string, string>>) =>
  JSON.stringify([
    id,
    provider ?? "",
    Object.entries(env ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ])

export class Harness extends Context.Service<
  Harness,
  {
    readonly available: (id: string) => Effect.Effect<boolean>
    readonly plugin: (id: string) => Effect.Effect<string, HarnessUnavailable>
    readonly models: (
      id: string,
      provider: string | null,
      env?: Readonly<Record<string, string>>,
    ) => Effect.Effect<ReadonlyArray<Model>, HarnessUnavailable>
  }
>()("vibest/Harness") {
  static readonly make = () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const pinned = Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(
        Context.add(FileSystem.FileSystem, fs),
        Context.add(Path.Path, path),
      )
      const harnesses = yield* Harnesses
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
      const cached = yield* Cache.makeWith(
        (key: string) => {
          const [id, providerName, entries] = JSON.parse(key) as [
            string,
            string,
            ReadonlyArray<readonly [string, string]>,
          ]
          const definition = harnesses.find(id)
          return definition === undefined
            ? Effect.fail(unprovided(id, harnesses.all))
            : listModels(definition, providerName === "" ? null : providerName, Object.fromEntries(entries)).pipe(
                Effect.provide(pinned),
              )
        },
        {
          capacity: MODEL_CACHE_CAPACITY,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? MODELS_TTL : Duration.zero),
        },
      )
      return Harness.of({
        available: (id) =>
          Effect.suspend(() => {
            const definition = harnesses.find(id)
            return definition === undefined
              ? Effect.succeed(false)
              : Effect.findFirst(searchPath, (dir) =>
                  fs.exists(path.join(dir, definition.binary)).pipe(Effect.orElseSucceed(() => false)),
                ).pipe(Effect.map((found) => found._tag === "Some"))
          }),
        plugin: (id) =>
          Effect.gen(function* () {
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
        models: (id, provider, env) => Cache.get(cached, modelCacheKey(id, provider, env)),
      })
    })

  static readonly layer = Layer.effect(Harness, Harness.make())

  static readonly node = LayerNode.make({
    service: Harness,
    layer: Harness.layer,
    deps: [Harnesses.node, PlatformNode.childProcessSpawner, PlatformNode.fileSystem, PlatformNode.path],
  })
}

export const preflight = Effect.fn("preflight")(function* (
  id: string,
  provider: string | null,
  model: string | null,
  env?: Readonly<Record<string, string>>,
) {
  const harness = yield* Harness
  const harnesses = yield* Harnesses
  const adapter = harnesses.find(id)
  if (adapter === undefined) return yield* unprovided(id, harnesses.all)
  const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
  const providerError = adapter.checkProvider?.(provider)
  if (providerError) return yield* unavailable(providerError)
  if (!(yield* harness.available(id))) return yield* unavailable(`${adapter.binary} is not on PATH`)
  yield* harness.plugin(id)
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

export const harnessCatalog = Effect.flatMap(Harnesses, (harnesses) =>
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

export const harnessOptions = Effect.map(harnessCatalog, (choices) =>
  choices.map((c): HarnessOption =>
    c.problem === null
      ? { harness: c.harness, available: true }
      : { harness: c.harness, available: false, problem: c.problem },
  ),
)
