import type { HarnessOption } from "@vibest/plugin"
import type { HarnessChoice } from "@vibest/protocol/rpc"
import { VibestCommand } from "@vibest/schema/layout"
import { HarnessUnavailable } from "@vibest/schema/session"
import { Clock, Config, Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"

import type { HarnessDefinition, HarnessesShape } from "./host.ts"
import type { Model } from "./models.ts"
import * as Registry from "./registry.ts"
export { type HarnessId, HarnessUnavailable } from "@vibest/schema/session"
export type { HarnessDefinition }

export const encodeCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))

export const unprovided = (id: string, loaded: ReadonlyArray<HarnessDefinition>) =>
  new HarnessUnavailable({
    harness: id,
    message: `no plugin provides harness ${id}; loaded: ${loaded.map((definition) => definition.id).join(", ") || "none"}`,
  })

export const makeHarnesses: Effect.Effect<HarnessesShape> = Effect.sync(() => {
  const registry = Registry.definitions<HarnessDefinition>("harness")
  const find = (id: string | null | undefined) =>
    id ? registry.get().find((definition) => definition.id === id) : undefined
  return {
    get all() {
      return registry.get()
    },
    get: (id) => {
      const found = find(id)
      if (found === undefined) throw unprovided(id, registry.get())
      return found
    },
    find,
    transform: registry.transform,
    reload: registry.reload,
  }
})

export class Harnesses extends Context.Service<Harnesses, HarnessesShape>()("vibest/Harnesses") {
  static readonly layer = Layer.effect(Harnesses, makeHarnesses)
}

export const hasNewline = (args: ReadonlyArray<string>) => args.some((a) => /[\r\n]/.test(a))

export const MODELS_TTL = Duration.minutes(5)

export class Harness extends Context.Service<
  Harness,
  {
    readonly available: (id: string) => Effect.Effect<boolean>
    readonly plugin: (id: string) => Effect.Effect<string, HarnessUnavailable>
    readonly models: (id: string, provider: string | null) => Effect.Effect<ReadonlyArray<Model>, HarnessUnavailable>
  }
>()("vibest/Harness") {
  static readonly make = () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
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
      const { listModels } = yield* Effect.promise(() => import("./models.ts"))
      const cache = new Map<string, { readonly at: number; readonly models: ReadonlyArray<Model> }>()
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
        models: (id, provider) =>
          Effect.gen(function* () {
            const key = `${id}/${provider ?? ""}`
            const now = yield* Clock.currentTimeMillis
            const hit = cache.get(key)
            if (hit && now - hit.at < Duration.toMillis(MODELS_TTL)) return hit.models
            const definition = harnesses.find(id)
            if (definition === undefined) return yield* unprovided(id, harnesses.all)
            const models = yield* listModels(definition, provider).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            )
            cache.set(key, { at: now, models })
            return models
          }),
      })
    })

  static readonly layer = Layer.effect(Harness, Harness.make())
}

export const preflight = Effect.fn("preflight")(function* (id: string, provider: string | null, model: string | null) {
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
    .models(id, provider)
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
