import type { Harness as HarnessApi, HarnessOption } from "@vibest/plugin"
import { VibestCommand } from "@vibest/schema/layout"
import { HarnessUnavailable } from "@vibest/schema/session"
// The harness registry: the built-in adapters (claude, pi, cursor, in harnesses/) and the ones plugins register with
// `context.harness.register`. Every place that differs by harness asks its adapter here, never the harness id.
import { Clock, Config, Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema, type Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"

import type { Model } from "./models.ts"
export { HarnessUnavailable } from "@vibest/schema/session"

/** A harness id: any registered adapter's; one read from the database that names none is unavailable, not invalid. */
export type HarnessId = string
export type HarnessAdapter = HarnessApi.HarnessAdapter
export type LaunchInput = HarnessApi.LaunchInput
export type CoordinatorInput = HarnessApi.CoordinatorInput
export type StartupPane = HarnessApi.StartupPane
export type Startup = HarnessApi.Startup

/** `[flag, value]`, or nothing when there is no value. */
/** A subagent on `adapter` takes its rows itself (`poll`) rather than having them typed. */
export const subagentPolls = (adapter: HarnessAdapter | undefined) =>
  (adapter?.subagentDelivery ?? adapter?.delivery) === "poll"

export const opt = (flag: string, value: string | null) => (value ? [flag, value] : [])
/** checkProvider for a harness that only runs Anthropic's models. */
export const anthropicOnly = (harness: string) => (provider: string | null) =>
  provider && provider !== "anthropic"
    ? `${harness} has no provider option; only "anthropic" (or none) is accepted, got "${provider}"`
    : undefined

/**
 * The plugin directory session `sessionId` runs with: `dir` itself, or for an adapter whose skills are the plugin
 * directory's (`skills: "plugin-dir"`) a copy under $TMPDIR/vibest/<session id>/ with only `skills` of its skills/.
 * Made again on every start (what the definition names now); files are copied, since a harness may refuse a plugin
 * file that resolves outside the plugin's folder.
 */
export const sessionPlugin = Effect.fn("sessionPlugin")(function* (
  adapter: HarnessAdapter,
  dir: string,
  sessionId: string,
  skills: ReadonlyArray<string>,
) {
  if (adapter.skills !== "plugin-dir" || dir === "") return dir
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // No skills to leave out (or a test's stand-in path): as it is; a launch checks the real one (preflight).
  if (!(yield* fs.exists(path.join(dir, "skills")))) return dir
  const tmp = yield* Config.String("TMPDIR").pipe(Effect.orElseSucceed(() => "/tmp"))
  const copy = path.join(tmp, "vibest", sessionId, `${adapter.id}-plugin`)
  yield* fs.remove(copy, { recursive: true, force: true })
  yield* fs.makeDirectory(copy, { recursive: true })
  for (const entry of yield* fs.readDirectory(dir))
    if (entry !== "skills") yield* fs.copy(path.join(dir, entry), path.join(copy, entry))
  for (const name of skills) {
    const from = path.join(dir, "skills", name)
    if (yield* fs.exists(from)) yield* fs.copy(from, path.join(copy, "skills", name))
  }
  return copy
})

/** argv as JSON, for the `VIBEST_COMMAND` env the Pi extension reads. */
export const encodeCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))

/** The registry's shape: built-ins first, then plugin adapters in registration order. */
export interface HarnessesShape {
  readonly all: () => ReadonlyArray<HarnessAdapter>
  /** The adapter of a registered id; an unregistered one is a defect (callers check with `find` first). */
  readonly get: (id: HarnessId) => HarnessAdapter
  /** The adapter of an id read from outside (the database, a flag); undefined when no adapter is registered for it. */
  readonly find: (id: string | null | undefined) => HarnessAdapter | undefined
  /** True for an adapter vibest ships, whose integration files are bundled under `harnesses/<id>`. */
  readonly bundled: (id: HarnessId) => boolean
  /** Register for the scope's lifetime (a plugin's); an id already registered fails. */
  readonly register: (adapter: HarnessAdapter) => Effect.Effect<void, never, Scope.Scope>
}

export class Harnesses extends Context.Service<Harnesses, HarnessesShape>()("vibest/Harnesses") {
  static readonly make = (builtins: ReadonlyArray<HarnessAdapter>): HarnessesShape => {
    // The plugin host registers and unregisters sequentially (one supervisor consumer).
    let registered: ReadonlyArray<HarnessAdapter> = []
    const all = () => [...builtins, ...registered]
    const find = (id: string | null | undefined) => (id ? all().find((a) => a.id === id) : undefined)
    return {
      all,
      find,
      get: (id) => {
        const found = find(id)
        if (!found)
          throw new Error(
            `no harness "${id}" is registered; registered: ${all()
              .map((a) => a.id)
              .join(", ")}`,
          )
        return found
      },
      bundled: (id) => builtins.some((a) => a.id === id),
      register: (adapter) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            if (find(adapter.id)) throw new Error(`harness "${adapter.id}" is already registered`)
            registered = [...registered, adapter]
          })
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              registered = registered.filter((a) => a !== adapter)
            }),
          )
        }),
    }
  }

  static readonly layer = (builtins: ReadonlyArray<HarnessAdapter>) =>
    Layer.sync(Harnesses, () => Harnesses.make(builtins))
}

/** Argv check: herdr refuses launch arguments containing newlines. */
export const hasNewline = (args: ReadonlyArray<string>) => args.some((a) => /[\r\n]/.test(a))

/** How long a successful model listing stands for "the CLI runs and its login works". */
export const MODELS_TTL = Duration.minutes(5)

/** The machine-facing side of the adapter table: what vibestd asks the host. Swapped out in tests. */
export class Harness extends Context.Service<
  Harness,
  {
    /** The harness binary is on PATH. */
    readonly available: (id: HarnessId) => Effect.Effect<boolean>
    /**
     * vibest's plugin for `id`, which vibest loads into each session it starts (`--plugin-dir`, `pi -e`): a directory of
     * VIBEST_HARNESSES (the npm package's bin/vibest.cjs sets it), else of `harnesses/` beside the compiled binary's
     * directory (`<root>/bin/vibest` and `<root>/harnesses`), so the binary alone runs without Node. Nothing is installed
     * into the harness's own config.
     */
    readonly plugin: (id: HarnessId) => Effect.Effect<string, HarnessUnavailable>
    /** `listModels`, successes cached for MODELS_TTL: the harness runs and its auth works. */
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
      // A compiled binary runs as itself alone; from source (`bun main.ts`) there is no layout to look beside.
      // Run bare (a pane vibestd opened runs the binary, not the npm launcher): `harnesses/` beside it (install.sh), else in
      // the @vibest/cli package it came with, flat (bun, npm dedupe: node_modules/@vibest/cli) or nested under it.
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
            // A plugin harness finds its own integration files from its module location.
            if (!harnesses.bundled(id)) return ""
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

/**
 * Everything that keeps `id` from running a session with `provider` / `model`, in order: provider accepted, binary
 * installed, vibest's plugin for it present, harness usable (lists its models), model one of those. Returns the models.
 */
export const preflight = Effect.fn("preflight")(function* (
  id: HarnessId,
  provider: string | null,
  model: string | null,
) {
  const harness = yield* Harness
  const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
  const adapter = (yield* Harnesses).find(id)
  if (!adapter) return yield* unavailable(`no harness "${id}" is registered (a plugin that adds it is not loaded)`)
  const providerError = adapter.checkProvider(provider)
  if (providerError) return yield* unavailable(providerError)
  if (!(yield* harness.available(id))) return yield* unavailable(`${adapter.binary} is not on PATH`)
  // Results only come from the plugin's turn-end hook (SPEC §2): no plugin, no session.
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

/** Every registered harness as preflight saw it, in registry order: what an `agent.start.before` chain chooses among. */
export const harnessOptions = Effect.flatMap(Harnesses, (harnesses) =>
  Effect.forEach(
    harnesses.all().map((a) => a.id),
    (id) =>
      preflight(id, null, null).pipe(
        Effect.map((): HarnessOption => ({ harness: id, available: true })),
        Effect.catchTag("HarnessUnavailable", (e) =>
          Effect.succeed<HarnessOption>({ harness: id, available: false, problem: e.message }),
        ),
      ),
    { concurrency: "unbounded" },
  ),
)
