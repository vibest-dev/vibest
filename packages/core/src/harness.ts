import type { HarnessOption } from "@vibest/plugin"
import { VibestCommand } from "@vibest/schema/layout"
import { HARNESS_IDS, type HarnessId, HarnessUnavailable, isHarnessId } from "@vibest/schema/session"
import { Clock, Config, Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"

import type { Model, ModelLister } from "./models.ts"
export { HARNESS_IDS, type HarnessId, HarnessUnavailable, isHarnessId } from "@vibest/schema/session"

export interface LaunchInput {
  readonly worktree: string
  readonly projectDir: string
  readonly systemPromptFile: string
  readonly provider: string | null
  readonly model: string | null
  readonly sessionId: string | null
  readonly resume: boolean
  readonly pluginDir: string
  readonly vibest: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

export interface CoordinatorInput {
  readonly root: string
  readonly projectDir: string
  readonly systemPromptFile: string
  readonly provider: string | null
  readonly model: string | null
  readonly sessionId: string | null
  readonly pluginDir: string
  readonly env: Readonly<Record<string, string>>
}

export interface StartupPane {
  readonly screen: Effect.Effect<string>
  readonly sendKeys: (keys: ReadonlyArray<string>) => Effect.Effect<void>
}

export type Startup = Effect.Effect<(pane: StartupPane) => Effect.Effect<void>>

export interface HarnessAdapter {
  readonly id: HarnessId
  readonly binary: string
  readonly ownSessionId: boolean
  readonly systemPromptInPrompt: boolean
  readonly interruptKey: string
  readonly startup?: Startup
  readonly resultField: "text" | "last_assistant_message"
  readonly inbox: "prompt" | "subscribe" | "poll"
  readonly ready: "integration" | "runtime"
  readonly checkProvider: (provider: string | null) => string | undefined
  readonly launchArgs: (input: LaunchInput) => ReadonlyArray<string>
  readonly coordinatorArgs?: (input: CoordinatorInput) => ReadonlyArray<string>
  readonly models: ModelLister
  readonly guardAnswer?: (reason: string | undefined) => unknown
  readonly turnEnd?: (
    event: Readonly<Record<string, unknown>>,
    coordinator: boolean,
  ) => { readonly result: Readonly<Record<string, unknown>> } | undefined
  readonly userPrompt?: (
    event: Readonly<Record<string, unknown>>,
    coordinator: boolean,
  ) => { readonly text: string } | undefined
  readonly conversationOf?: (event: Readonly<Record<string, unknown>>) => string | undefined
  readonly canResume?: (
    root: string,
    sessionId: string,
  ) => Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>
}

export const opt = (flag: string, value: string | null) => (value ? [flag, value] : [])
export const anthropicOnly = (harness: string) => (provider: string | null) =>
  provider && provider !== "anthropic"
    ? `${harness} has no provider option; only "anthropic" (or none) is accepted, got "${provider}"`
    : undefined

export const encodeCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))

export class Harnesses extends Context.Service<
  Harnesses,
  {
    readonly all: ReadonlyArray<HarnessAdapter>
    readonly get: (id: HarnessId) => HarnessAdapter
    readonly find: (id: string | null | undefined) => HarnessAdapter | undefined
  }
>()("vibest/Harnesses") {
  static readonly layer = (adapters: Readonly<Record<HarnessId, HarnessAdapter>>) =>
    Layer.succeed(
      Harnesses,
      Harnesses.of({
        all: HARNESS_IDS.map((id) => adapters[id]),
        get: (id) => adapters[id],
        find: (id) => (id && isHarnessId(id) ? adapters[id] : undefined),
      }),
    )
}

export const hasNewline = (args: ReadonlyArray<string>) => args.some((a) => /[\r\n]/.test(a))

export const MODELS_TTL = Duration.minutes(5)

export class Harness extends Context.Service<
  Harness,
  {
    readonly available: (id: HarnessId) => Effect.Effect<boolean>
    readonly plugin: (id: HarnessId) => Effect.Effect<string, HarnessUnavailable>
    readonly models: (id: HarnessId, provider: string | null) => Effect.Effect<ReadonlyArray<Model>, HarnessUnavailable>
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
          Effect.findFirst(searchPath, (dir) =>
            fs.exists(path.join(dir, harnesses.get(id).binary)).pipe(Effect.orElseSucceed(() => false)),
          ).pipe(Effect.map((found) => found._tag === "Some")),
        plugin: (id) =>
          Effect.gen(function* () {
            const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
            if (!plugins)
              return yield* unavailable(
                "VIBEST_HARNESSES is not set, and vibest runs from source; set it to a built harnesses/ directory",
              )
            const dir = path.join(plugins, id)
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
            const models = yield* listModels(harnesses.get(id), provider).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            )
            cache.set(key, { at: now, models })
            return models
          }),
      })
    })

  static readonly layer = Layer.effect(Harness, Harness.make())
}

export const preflight = Effect.fn("preflight")(function* (
  id: HarnessId,
  provider: string | null,
  model: string | null,
) {
  const harness = yield* Harness
  const adapter = (yield* Harnesses).get(id)
  const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
  const providerError = adapter.checkProvider(provider)
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

export const harnessOptions = Effect.forEach(
  HARNESS_IDS,
  (id) =>
    preflight(id, null, null).pipe(
      Effect.map((): HarnessOption => ({ harness: id, available: true })),
      Effect.catchTag("HarnessUnavailable", (e) =>
        Effect.succeed<HarnessOption>({ harness: id, available: false, problem: e.message }),
      ),
    ),
  { concurrency: "unbounded" },
)
