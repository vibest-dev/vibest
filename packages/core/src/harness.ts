// HarnessAdapter: everything that differs between pi / claude / cursor (SPEC §10); each adapter lives in harnesses/ and
// reaches the code through the `Harnesses` service.
import { Clock, Config, Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { HarnessOption } from "@vibest/plugin"
import type { Model, ModelLister } from "./models.ts"
import { VibestCommand } from "@vibest/schema/layout"
import { HARNESS_IDS, type HarnessId, HarnessUnavailable, isHarnessId } from "@vibest/schema/session"
export { HARNESS_IDS, type HarnessId, HarnessUnavailable, isHarnessId } from "@vibest/schema/session"

export interface LaunchInput {
  readonly worktree: string
  readonly scratch: string
  /** Cursor takes the rules in its first prompt; Pi and Claude read `rulesFile` (herdr refuses multi-line args). */
  readonly rules: string
  readonly rulesFile: string
  /** `~/.vibest/projects`, denied to Claude's file tools. */
  readonly projectsDir: string
  readonly provider: string | null
  readonly model: string | null
  /** Pi / Claude: the uuid vibestd chose. Cursor: the id herdr reported (resume only). */
  readonly sessionId: string | null
  readonly resume: boolean
  /** vibest's plugin for this harness (`Harness.plugin`), loaded for this session only. */
  readonly pluginDir: string
  /** argv that runs vibest, for the permission to run `vibest report`. */
  readonly vibest: ReadonlyArray<string>
  /** vibest's variables for the session's shell (VIBEST_SESSION_ID, VIBEST_AGENT …). */
  readonly env: Readonly<Record<string, string>>
}

/** What `vibest` starts the main agent with (SPEC §12.1). */
export interface CoordinatorInput {
  /** Repository root, the Coordinator's working directory. */
  readonly root: string
  readonly rules: string
  readonly rulesFile: string
  readonly provider: string | null
  readonly model: string | null
  /** The repository's Coordinator session to reopen, as the harness reported it after a turn; null: the harness starts a new one. */
  readonly sessionId: string | null
  /** A new conversation under this id, chosen by vibest so vibestd knows it before the first turn ends (the bridge inbox attaches at once). */
  readonly newSessionId?: string
  /** vibest's plugin for this harness (`Harness.plugin`). */
  readonly pluginDir: string
  /** vibest's variables for the coordinator's shell (VIBEST_AGENT, HERDR_PANE_ID …). */
  readonly env: Readonly<Record<string, string>>
}

/** The session's pane while the harness starts, as a startup adapter sees it. */
export interface StartupPane {
  /** The last 40 lines on screen. */
  readonly screen: Effect.Effect<string>
  readonly sendKeys: (keys: ReadonlyArray<string>) => Effect.Effect<void>
}

/** Per launch: makes the step vibestd runs on every tick until the harness is `interactive_ready`. */
export type Startup = Effect.Effect<(pane: StartupPane) => Effect.Effect<void>>

export interface HarnessAdapter {
  readonly id: HarnessId
  /** Executable that must be on PATH. */
  readonly binary: string
  /** vibestd picks the session id up front (Pi, Claude); otherwise herdr reports it after launch. */
  readonly ownSessionId: boolean
  /** No system-prompt flag: rules go in front of the first prompt (Cursor). */
  readonly rulesInPrompt: boolean
  readonly interruptKey: string
  /** Harness-specific startup handling while vibestd waits for ready (Claude: its trust / bypass menus). */
  readonly startup?: Startup
  /** Field of the hook payload holding the last reply. */
  readonly resultField: "text" | "last_assistant_message"
  /**
   * A Coordinator's inbox rows: typed into its pane (`prompt`), taken over vibest.sock by its integration (`subscribe`),
   * or pulled by its integration's bridge while one is attached and typed in otherwise (`bridge`).
   */
  readonly inbox: "prompt" | "subscribe" | "bridge"
  /** Error message when this harness cannot use `provider`, else undefined. */
  readonly checkProvider: (provider: string | null) => string | undefined
  readonly launchArgs: (input: LaunchInput) => ReadonlyArray<string>
  /**
   * Coordinator argv: its rules and the inspection tools, among them the shell it runs `vibest` in; no MCP servers.
   * Absent: the harness is not currently supported as a Coordinator (Cursor).
   */
  readonly coordinatorArgs?: (input: CoordinatorInput) => ReadonlyArray<string>
  /** How the harness lists its models. */
  readonly models: ModelLister
  /** The pre-tool hook's answer in the harness's format; `reason` refuses the call. Absent: the harness guards in process (Pi). */
  readonly guardAnswer?: (reason: string | undefined) => unknown
  /**
   * A turn end the harness's own plugin hands to `vibest integration stop`: a session's result payload, or the
   * coordinator's conversation id; undefined ignores it. Absent: the harness reports turn ends another way.
   */
  readonly turnEnd?: (event: Readonly<Record<string, unknown>>, coordinator: boolean) => { readonly result: Readonly<Record<string, unknown>> } | { readonly harnessSessionId: string } | undefined
  /**
   * A prompt the harness plugin hands to `vibest integration prompt`. Undefined ignores it: the main agent,
   * a nested agent, or text that is not the user typing.
   */
  readonly userPrompt?: (event: Readonly<Record<string, unknown>>, coordinator: boolean) => { readonly text: string } | undefined
  /** Whether conversation `sessionId` can be reopened at `root`. Absent: it can. */
  readonly canResume?: (root: string, sessionId: string) => Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>
}

/** `[flag, value]`, or nothing when there is no value. */
export const opt = (flag: string, value: string | null) => (value ? [flag, value] : [])
/** checkProvider for a harness that only runs Anthropic's models. */
export const anthropicOnly = (harness: string) => (provider: string | null) =>
  provider && provider !== "anthropic" ? `${harness} has no provider option; only "anthropic" (or none) is accepted, got "${provider}"` : undefined

/** argv as JSON, for the `VIBEST_COMMAND` env the Pi extension reads. */
export const encodeCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))

/**
 * The harnesses vibest runs, provided by the composition root: every place that differs by harness asks its adapter
 * here, never the harness id.
 */
export class Harnesses extends Context.Service<Harnesses, {
  readonly all: ReadonlyArray<HarnessAdapter>
  readonly get: (id: HarnessId) => HarnessAdapter
  /** The adapter of an id read from outside (herdr, the database); undefined when it names no harness. */
  readonly find: (id: string | null | undefined) => HarnessAdapter | undefined
}>()("vibest/Harnesses") {
  static readonly layer = (adapters: Readonly<Record<HarnessId, HarnessAdapter>>) =>
    Layer.succeed(Harnesses, Harnesses.of({
      all: HARNESS_IDS.map((id) => adapters[id]),
      get: (id) => adapters[id],
      find: (id) => (id && isHarnessId(id) ? adapters[id] : undefined),
    }))
}

/** Argv check: herdr refuses launch arguments containing newlines. */
export const hasNewline = (args: ReadonlyArray<string>) => args.some((a) => /[\r\n]/.test(a))

/** How long a successful model listing stands for "the CLI runs and its login works". */
export const MODELS_TTL = Duration.minutes(5)

/** The machine-facing side of the adapter table: what vibestd asks the host. Swapped out in tests. */
export class Harness extends Context.Service<Harness, {
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
}>()("vibest/Harness") {
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
      const beside = pkg === undefined
        ? undefined
        : yield* Effect.findFirst(
            [path.join(pkg, "harnesses"), path.join(pkg, "..", "cli", "harnesses"), path.join(pkg, "..", "..", "..", "harnesses")],
            (dir) => fs.exists(dir).pipe(Effect.orElseSucceed(() => false)),
          ).pipe(Effect.map((found) => Option.getOrElse(found, () => path.join(pkg, "harnesses"))))
      const plugins = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_HARNESSES"))) || beside
      const searchPath = (yield* Config.String("PATH").pipe(Config.withDefault(""))).split(":").filter(Boolean)
      const { listModels } = yield* Effect.promise(() => import("./models.ts"))
      const cache = new Map<string, { readonly at: number; readonly models: ReadonlyArray<Model> }>()
      return Harness.of({
        available: (id) =>
          Effect.findFirst(searchPath, (dir) => fs.exists(path.join(dir, harnesses.get(id).binary)).pipe(Effect.orElseSucceed(() => false))).pipe(
            Effect.map((found) => found._tag === "Some"),
          ),
        plugin: (id) =>
          Effect.gen(function* () {
            const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
            if (!plugins) return yield* unavailable("VIBEST_HARNESSES is not set, and vibest runs from source; set it to a built harnesses/ directory")
            const dir = path.join(plugins, id)
            if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return yield* unavailable(`vibest's ${id} plugin is missing: ${dir}`)
            return dir
          }),
        models: (id, provider) =>
          Effect.gen(function* () {
            const key = `${id}/${provider ?? ""}`
            const now = yield* Clock.currentTimeMillis
            const hit = cache.get(key)
            if (hit && now - hit.at < Duration.toMillis(MODELS_TTL)) return hit.models
            const models = yield* listModels(harnesses.get(id), provider).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
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
export const preflight = Effect.fn("preflight")(function* (id: HarnessId, provider: string | null, model: string | null) {
  const harness = yield* Harness
  const adapter = (yield* Harnesses).get(id)
  const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
  const providerError = adapter.checkProvider(provider)
  if (providerError) return yield* unavailable(providerError)
  if (!(yield* harness.available(id))) return yield* unavailable(`${adapter.binary} is not on PATH`)
  // Results only come from the plugin's turn-end hook (SPEC §2): no plugin, no session.
  yield* harness.plugin(id)
  const models = yield* harness.models(id, provider).pipe(
    Effect.mapError((e) => unavailable(`${id} model discovery failed: ${e.message}`)),
  )
  if (model !== null && !models.some((m) => m.model === model)) {
    const choices = models.map((m) => (m.provider ? `${m.provider}/${m.model}` : m.model)).join(", ")
    return yield* unavailable(`${id} does not list model "${model}"${provider ? ` for provider "${provider}"` : ""}; choose one of: ${choices}`)
  }
  return models
})

/** Every harness as preflight saw it, in HARNESS_IDS order: what an `agent.start.before` chain chooses among. */
export const harnessOptions = Effect.forEach(
  HARNESS_IDS,
  (id) =>
    preflight(id, null, null).pipe(
      Effect.map((): HarnessOption => ({ harness: id, available: true })),
      Effect.catchTag("HarnessUnavailable", (e) => Effect.succeed<HarnessOption>({ harness: id, available: false, problem: e.message })),
    ),
  { concurrency: "unbounded" },
)
