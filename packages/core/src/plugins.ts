// Plugins (plugins.md): found and loaded the way OpenCode V2 does it (§4), kept current by a supervisor that reloads
// what changed on disk; their hooks run under vibest's own rules (§5): one event mutated in place, a diff of what each
// callback changed, a timeout, and refusals or failures that always surface.
import type * as VibestPlugin from "@vibest/plugin"
import { AgentRefused, HookFailed, PluginInfo, Routing, TraceEntry } from "@vibest/schema/plugin"
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect"

import { harnessChoicePlugin } from "./builtin/harness-choice.ts"
import { type Candidate, makeSources, makeWatcher, messageOf, PluginLoader } from "./plugin-sources.ts"
import { machinesListing, Runtimes } from "./runtimes.ts"
import { Subscriptions } from "./subscriptions/service.ts"
export { AgentRefused, Change, HookFailed, PluginInfo, Routing, TraceEntry } from "@vibest/schema/plugin"

export { type Candidate, pluginEntries, PluginLoader } from "./plugin-sources.ts"

export const DEFAULT_TIMEOUT = Duration.seconds(5)
/** How long a spawn waits for plugins being (re)loaded before it goes on with the active ones (plugins.md §5). */
const ACTIVATION_WAIT = Duration.seconds(10)
/** Quiet time after a file change before reloading, so a burst of saves is one reload. */
const DEBOUNCE = Duration.millis(100)
/** When to read once more after the watched directories changed (see `Plugins.layer`). */
const RECHECK = Duration.seconds(1)

type HookName = keyof VibestPlugin.Hooks

/** "claude / claude-haiku-5-5 (chosen by plugin route)" */
export const describeSpawn = (s: {
  harness: string
  provider?: string | undefined
  model?: string | undefined
  decidedBy: Readonly<Record<string, string>>
}) => {
  const plugins = [...new Set(Object.values(s.decidedBy))]
  const by = plugins.length === 0 ? "" : ` (chosen by plugin ${plugins.join(", ")})`
  return [s.harness, s.provider, s.model].filter(Boolean).join(" / ") + by
}

/** Before any Agent starts, the main agent included: the event minus what the host itself reads. */
export type StartInput = Omit<VibestPlugin.AgentStartBefore, "subscriptions">

/** A started Agent's round failed; `agent.fail` decides whether it moves. */
export type FailInput = Omit<VibestPlugin.AgentFail, "subscriptions" | "move">

export interface SpawnDecision extends Routing {
  readonly prompt: string
  readonly harness: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  /** Where the Agent runs: the machine the start named, and the runtime the chain chose (unchanged when no plugin set one). */
  readonly machine: { readonly id: string }
  readonly runtime: string | undefined
}

type Stats = {
  calls: number
  changed: number
  crashed: number
  timedOut: number
  refused: number
  lastError: string | undefined
}
type HookFn<N extends HookName> = (
  event: VibestPlugin.Hooks[N]["event"],
) => Effect.Effect<void, VibestPlugin.Hooks[N]["error"]>
type Registered<N extends HookName> = {
  readonly plugin: string
  readonly scope: Scope.Scope
  readonly stats: Stats
  readonly callback: HookFn<N>
}
/** One list per hook, so a callback is stored and called as that hook's event. */
type HookBuckets = { [N in HookName]: Array<Registered<N>> }
const emptyBuckets = (): HookBuckets => ({ "agent.start.before": [], "agent.fail": [] })
type Loaded = Candidate & { readonly plugin: VibestPlugin.Plugin.Plugin }
/** The builtin default harness choice, first in every list (architecture.md §9); user plugins run after it. */
const builtin: Candidate = {
  source: "builtin:harness-choice",
  revision: "harness-choice",
  options: {},
  plugin: harnessChoicePlugin,
}
/** Builtin plugins of the host app (the runtime plugins, runtime-port.md §2), after the default choice. */
export const Builtins = Context.Reference<ReadonlyArray<Candidate>>("vibest/Plugins/Builtins", {
  defaultValue: () => [],
})
/** A plugin set up in its own scope, with the hooks it registered there. */
type Running = { readonly candidate: Loaded; readonly scope: Scope.Closeable; readonly hooks: HookBuckets }
/**
 * One plugin in the requested order. `running` is what is set up: `candidate` itself, or the last revision of the same
 * source that worked while `candidate` fails (`failure`). A failed setup (`setupFailed`) is not retried until the
 * candidate changes.
 */
type Slot = {
  readonly candidate: Candidate
  readonly running: Running | undefined
  readonly failure: string | undefined
  /** Why the last working revision could not be restored in its place. */
  readonly rollback?: string
  readonly setupFailed: boolean
  readonly loadedAt: number
  readonly stats: Stats
}

/** Same source, revision and options: the same plugin, which a reload keeps if everything before it is kept too. */
const keyOf = (c: Candidate) => JSON.stringify([c.source, c.revision, c.options])

const info = (slot: Slot): PluginInfo => {
  const { candidate, running, failure } = slot
  const shown = running?.candidate ?? candidate
  return {
    id: running?.candidate.plugin.id ?? ("error" in candidate.plugin ? candidate.source : candidate.plugin.id),
    source: shown.source,
    revision: shown.revision,
    loadedAt: slot.loadedAt,
    status: running ? "active" : "failed",
    ...(failure === undefined
      ? {}
      : {
          error: running
            ? `revision ${candidate.revision} failed, still running ${shown.revision}: ${failure}`
            : [failure, slot.rollback].filter(Boolean).join("; "),
        }),
    ...slot.stats,
  }
}

export const errorMessage = (cause: Cause.Cause<unknown>) => messageOf(Cause.squash(cause))
const isAgentRefused = (e: unknown): e is VibestPlugin.AgentRefused =>
  (e as { _tag?: unknown } | undefined)?._tag === "AgentRefused"

/** The top-level fields `after` changed, each attributed to `plugin` in `decidedBy` (which it updates). */
const diff = (before: object, after: object, plugin: string, decidedBy: Record<string, string>) => {
  const [from, to] = [before as Record<string, unknown>, after as Record<string, unknown>]
  return [...new Set([...Object.keys(from), ...Object.keys(to)])].flatMap((field) => {
    if (JSON.stringify(from[field]) === JSON.stringify(to[field])) return []
    const change = {
      field,
      ...(from[field] !== undefined ? { from: from[field] } : {}),
      ...(to[field] !== undefined ? { to: to[field] } : {}),
      ...(decidedBy[field] ? { overwrote: decidedBy[field] } : {}),
    }
    decidedBy[field] = plugin
    return [change]
  })
}

/**
 * Run `effect` in a fiber owned by `scope` and wait at most `timeout`. Waiting on the fiber rather than timing the effect
 * itself returns on time even when the plugin is inside an uninterruptible region (plugins.md §2); the abandoned fiber
 * is interrupted in the background and otherwise ends with the scope.
 */
const runBounded = <A, E>(effect: Effect.Effect<A, E>, scope: Scope.Scope, timeout: Duration.Input) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkIn(
      Effect.suspend(() => effect),
      scope,
    )
    const exit = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(timeout))
    if (Option.isNone(exit)) yield* Effect.forkDetach(Fiber.interrupt(fiber))
    return exit
  })

/** How one callback stopped the chain: the plugin and the full reason text (wire error, log, result). */
type Stopped = { readonly plugin: string; readonly reason: string }

/**
 * The plugin set and how to replace it. `activate` keeps the longest unchanged prefix, tears the rest down (last
 * first) and sets the new suffix up in order (OpenCode V2 `core/src/plugin.ts`); spawns wait while `ready` is closed.
 */
export const makeHost = (options: { readonly timeout?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const root = yield* Effect.scope
    const ready = yield* Latch.make(true)
    /** What dispatch reads; replaced whole, never edited in place. */
    let slots: ReadonlyArray<Slot> = []
    /** Dispatches in flight: a reload tears hooks down only once none is still running them. */
    let dispatching = 0
    const idle = yield* Latch.make(true)

    /** Close a plugin scope, waiting at most `timeout` for its finalizers. */
    const close = (scope: Scope.Closeable, id: string) =>
      runBounded(Scope.close(scope, Exit.void), root, timeout).pipe(
        Effect.flatMap((exit) =>
          Option.isNone(exit)
            ? Effect.logWarning(`plugin ${id}: teardown timed out; left to finish on its own`)
            : Effect.void,
        ),
      )

    const subscriptions = yield* Subscriptions
    const runtimes = yield* Runtimes
    /** Set `candidate` up in a new scope: what runs, or why it failed. */
    const setUp = Effect.fnUntraced(function* (candidate: Loaded, stats: Stats) {
      const plugin = candidate.plugin
      const scope = yield* Scope.fork(root)
      const buckets = emptyBuckets()
      const running: Running = { candidate, scope, hooks: buckets }
      const remember = <N extends HookName>(name: N, callback: HookFn<N>) =>
        Effect.gen(function* () {
          const list: Array<Registered<N>> = buckets[name]
          const entry: Registered<N> = { plugin: plugin.id, scope, stats, callback }
          list.push(entry)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              const index = list.indexOf(entry)
              if (index >= 0) list.splice(index, 1)
            }),
          )
        })
      // Each short name registers into its own list. A plain-JS plugin can pass any string; that fails setup.
      const bind = (
        prefix: "agent",
        register: {
          [S in VibestPlugin.HookOf<"agent">]: (
            callback: HookFn<Extract<`agent.${S}`, HookName>>,
          ) => Effect.Effect<void, never, Scope.Scope>
        },
      ): VibestPlugin.Domain<"agent"> => ({
        hook: <S extends VibestPlugin.HookOf<"agent">>(short: S, callback: HookFn<Extract<`agent.${S}`, HookName>>) => {
          // hasOwn, not a property read: `toString` is on the prototype and is not a hook.
          if (typeof short !== "string" || !Object.hasOwn(register, short)) {
            return Effect.die(
              new Error(
                `unsupported hook ${JSON.stringify(`${prefix}.${String(short)}`)}; supported: ${Object.keys(register)
                  .map((s) => `${prefix}.${s}`)
                  .join(", ")}`,
              ),
            )
          }
          const call: (callback: HookFn<Extract<`agent.${S}`, HookName>>) => Effect.Effect<void, never, Scope.Scope> =
            register[short]
          return call(callback)
        },
      })
      const ctx: VibestPlugin.Context = {
        options: candidate.options,
        agent: bind("agent", {
          "start.before": (callback) => remember("agent.start.before", callback),
          fail: (callback) => remember("agent.fail", callback),
        }),
        // Beside agent.hook (runtime-port.md §2): registered for the plugin's lifetime, in the plugin's own scope.
        runtime: { register: (runtime) => runtimes.register(runtime).pipe(Scope.provide(scope)) },
        subscription: { report: (input) => subscriptions.report(input) },
      }
      const exit = yield* runBounded(plugin.effect(ctx).pipe(Scope.provide(scope)), scope, timeout)
      const error = Option.isNone(exit)
        ? "setup timed out"
        : Exit.isFailure(exit.value)
          ? errorMessage(exit.value.cause)
          : undefined
      if (error === undefined) {
        yield* Effect.log(`plugin ${plugin.id} loaded from ${candidate.source} (revision ${candidate.revision})`)
        return running
      }
      yield* close(scope, plugin.id)
      yield* Effect.logWarning(`plugin ${plugin.id} failed to load: ${error}`)
      return error
    })

    /** The slot for `candidate`, which replaces `previous` (the same source in the torn-down suffix, if any). */
    const build = Effect.fnUntraced(function* (
      candidate: Candidate,
      previous: Slot | undefined,
      ids: ReadonlySet<string>,
    ) {
      const stats = previous?.stats ?? {
        calls: 0,
        changed: 0,
        crashed: 0,
        timedOut: 0,
        refused: 0,
        lastError: undefined,
      }
      const base = {
        candidate,
        running: undefined,
        failure: undefined,
        setupFailed: false,
        loadedAt: yield* Clock.currentTimeMillis,
        stats,
      }
      const plugin = candidate.plugin
      if (!("error" in plugin) && ids.has(plugin.id)) return { ...base, failure: `Duplicate plugin ID: ${plugin.id}` }
      const unchanged = previous !== undefined && keyOf(previous.candidate) === keyOf(candidate)
      // Being rebuilt after an earlier plugin changed is no reason to run a setup that already failed.
      const outcome =
        "error" in plugin
          ? plugin.error
          : unchanged && previous.setupFailed
            ? previous.failure!
            : yield* setUp({ ...candidate, plugin }, stats)
      if (typeof outcome !== "string") return { ...base, running: outcome }
      const failed: Slot = { ...base, failure: outcome, setupFailed: !("error" in plugin) }
      // The last revision that worked keeps running while this one fails, under the same rules (its id must still be free).
      const last = previous?.running?.candidate
      if (last === undefined) {
        // Rebuilt unchanged, a failure keeps saying why the revision before it is not running either.
        return unchanged && previous.rollback !== undefined ? { ...failed, rollback: previous.rollback } : failed
      }
      const restored = ids.has(last.plugin.id) ? `Duplicate plugin ID: ${last.plugin.id}` : yield* setUp(last, stats)
      return typeof restored === "string"
        ? { ...failed, rollback: `revision ${last.revision} not restored: ${restored}` }
        : { ...failed, running: restored }
    })

    /** Callers run one at a time (the supervisor's single consumer). */
    const activate = Effect.fnUntraced(function* (candidates: ReadonlyArray<Candidate>) {
      let prefix = 0
      while (
        prefix < candidates.length &&
        prefix < slots.length &&
        keyOf(slots[prefix]!.candidate) === keyOf(candidates[prefix]!)
      )
        prefix++
      if (prefix === candidates.length && prefix === slots.length) return
      const retired = slots.slice(prefix)
      // Dispatch always sees an ordered prefix of plugins that are fully set up: first the unchanged ones, then each
      // rebuilt one as it is ready. The old suffix goes once no dispatch still runs it.
      slots = slots.slice(0, prefix)
      yield* idle.await
      // ponytail: a teardown that times out is left running, so an old revision's finalizers can overlap the new setup.
      for (const slot of retired.toReversed())
        if (slot.running) yield* close(slot.running.scope, slot.running.candidate.plugin.id)
      const ids = new Set(slots.flatMap((s) => (s.running ? [s.running.candidate.plugin.id] : [])))
      for (const candidate of candidates.slice(prefix)) {
        const slot = yield* build(
          candidate,
          retired.find((s) => s.candidate.source === candidate.source),
          ids,
        )
        if (slot.running) ids.add(slot.running.candidate.plugin.id)
        slots = [...slots, slot]
      }
    })

    /** Wait for a pending reload, at most ACTIVATION_WAIT: false when it is still going. */
    const settled = ready.await.pipe(Effect.timeoutOption(ACTIVATION_WAIT), Effect.map(Option.isSome))

    const bucket = <N extends HookName>(hooks: ReadonlyArray<HookBuckets>, name: N) => hooks.flatMap((set) => set[name])

    /**
     * Run `name`'s callbacks on `event`, in plugin order, each mutating it in place; `decidedBy` attributes each changed
     * field to the plugin that wrote it last. Only `agent.start.before` can refuse: anywhere else an `AgentRefused`
     * counts as a crash. Undefined when the chain finished; a `Stopped` says which callback ended it and why.
     */
    const runHook = Effect.fnUntraced(function* <N extends HookName>(
      hooks: ReadonlyArray<Registered<N>>,
      name: N,
      event: VibestPlugin.Hooks[N]["event"],
      trace: Array<TraceEntry>,
      decidedBy: Record<string, string> = {},
    ) {
      for (const hook of hooks) {
        const before = { ...event }
        const started = yield* Clock.currentTimeMillis
        const exit = yield* runBounded(hook.callback(event), hook.scope, timeout).pipe(
          Effect.withSpan("vibest.plugin.hook", { attributes: { "plugin.id": hook.plugin, hook: name } }),
        )
        const ms = (yield* Clock.currentTimeMillis) - started
        const entry = { plugin: hook.plugin, hook: name, ms, changes: [] }
        hook.stats.calls++
        if (Option.isNone(exit)) {
          const message = `plugin ${hook.plugin} timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`
          hook.stats.timedOut++
          hook.stats.lastError = message
          trace.push({ ...entry, outcome: "timeout", error: message })
          yield* Effect.logWarning(`plugin ${hook.plugin} ${name}: ${message}`)
          return { plugin: hook.plugin, reason: message } satisfies Stopped
        }
        if (Exit.isFailure(exit.value)) {
          const refused = Option.filter(Cause.findErrorOption(exit.value.cause), isAgentRefused)
          if (name === "agent.start.before" && Option.isSome(refused)) {
            hook.stats.refused++
            trace.push({ ...entry, outcome: "refused", reason: refused.value.reason })
            yield* Effect.log(`plugin ${hook.plugin} ${name}: refused (${refused.value.reason})`)
            return { plugin: hook.plugin, reason: refused.value.reason } satisfies Stopped
          }
          const message = errorMessage(exit.value.cause)
          const reason = `plugin ${hook.plugin} crashed: ${message}`
          hook.stats.crashed++
          hook.stats.lastError = message
          trace.push({ ...entry, outcome: "crashed", error: message })
          yield* Effect.logWarning(`plugin ${hook.plugin} ${name} crashed: ${Cause.pretty(exit.value.cause)}`)
          return { plugin: hook.plugin, reason } satisfies Stopped
        }
        const changes = diff(before, event, hook.plugin, decidedBy)
        if (changes.length > 0) hook.stats.changed++
        trace.push({ ...entry, outcome: "ok", changes })
        const summary =
          changes
            .map((c) => `${c.field} ${JSON.stringify(c.from) ?? "-"} → ${JSON.stringify(c.to) ?? "-"}`)
            .join(", ") || "no change"
        yield* Effect.log(`plugin ${hook.plugin} ${name}: ${summary} (${ms} ms)`)
      }
      return undefined
    })

    /** The refusal an `agent.start.before` chain ended with: a real refusal as it was, a crash or timeout in its words. */
    const refusal = (stopped: Stopped) => new AgentRefused({ plugin: stopped.plugin, reason: stopped.reason })

    /** The failure an `agent.fail` chain ended with: that operation fails. */
    const failure = (stopped: Stopped) => new HookFailed({ message: stopped.reason })

    /** Run `f` on the active hooks once a pending reload settles (waiting at most ACTIVATION_WAIT); a reload waits for it. */
    const withHooks = <A, E>(
      name: string,
      f: (hooks: ReadonlyArray<HookBuckets>, trace: Array<TraceEntry>) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const trace: Array<TraceEntry> = []
        const started = yield* Clock.currentTimeMillis
        if (!(yield* settled)) {
          trace.push({
            plugin: "vibest",
            hook: name,
            outcome: "timeout",
            ms: (yield* Clock.currentTimeMillis) - started,
            changes: [],
            error: "plugins still activating",
          })
          yield* Effect.logWarning(`${name}: plugins still activating; going on with the active ones`)
        }
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            if (dispatching++ === 0) idle.closeUnsafe()
            return slots.flatMap((s) => (s.running ? [s.running.hooks] : []))
          }),
          (hooks) => f(hooks, trace),
          () => Effect.sync(() => (--dispatching === 0 ? idle.openUnsafe() : undefined)),
        )
      })

    const start = Effect.fn("Plugins.start")(function* (input: StartInput) {
      return yield* withHooks("agent.start.before", (hooks, trace) =>
        Effect.gen(function* () {
          const current = yield* subscriptions.list
          // Listed again now the plugins are active: a caller that listed before the first activation (a start right
          // after vibestd came up) saw no runtime registered yet, and the choice would find none online.
          const machines = yield* machinesListing(runtimes, input.machines[0]?.harnesses ?? [])
          const event: VibestPlugin.AgentStartBefore = { ...input, machines, subscriptions: current }
          const decidedBy: Record<string, string> = {}
          const stopped = yield* runHook(
            bucket(hooks, "agent.start.before"),
            "agent.start.before",
            event,
            trace,
            decidedBy,
          )
          if (stopped !== undefined) return yield* refusal(stopped)
          return {
            prompt: event.prompt,
            harness: event.harness,
            provider: event.provider,
            model: event.model,
            machine: event.machine,
            runtime: event.runtime,
            decidedBy,
            trace,
          } satisfies SpawnDecision
        }),
      )
    })

    const fail = Effect.fn("Plugins.fail")(function* (input: FailInput) {
      return yield* withHooks("agent.fail", (hooks, trace) =>
        Effect.gen(function* () {
          const event: VibestPlugin.AgentFail = { ...input, subscriptions: yield* subscriptions.list, move: undefined }
          const stopped = yield* runHook(bucket(hooks, "agent.fail"), "agent.fail", event, trace)
          if (stopped !== undefined) return yield* failure(stopped)
          return { move: event.move, trace }
        }),
      )
    })

    const list = settled.pipe(Effect.andThen(Effect.sync(() => slots.map(info))))
    return { service: Plugins.of({ start, fail, list }), activate, ready }
  })

export class Plugins extends Context.Service<
  Plugins,
  {
    /**
     * Before any Agent starts, the main agent included: every `agent.start.before` callback in plugin order, each
     * mutating one event. A refusal (or a crash, or a timeout: the host says which) stops the chain and fails the start.
     */
    readonly start: (input: StartInput) => Effect.Effect<SpawnDecision, AgentRefused>
    /**
     * A started Agent's round failed: every `agent.fail` callback in plugin order; the last one to write `move` decides
     * where the session restarts (undefined: nowhere). A crash or a timeout fails this, and the round ends failed.
     */
    readonly fail: (
      input: FailInput,
    ) => Effect.Effect<
      { readonly move: VibestPlugin.AgentFail["move"]; readonly trace: ReadonlyArray<TraceEntry> },
      HookFailed
    >
    readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
  }
>()("vibest/Plugins") {
  /** Set up the builtin default and `candidates` in order, each in its own scope under the caller's. */
  static readonly make = (candidates: ReadonlyArray<Candidate>, options: { readonly timeout?: Duration.Input } = {}) =>
    makeHost(options).pipe(
      Effect.tap((host) => host.activate([builtin, ...candidates])),
      Effect.map((host) => host.service),
    )

  /**
   * Plugins from VIBEST_HOME (`plugins/` then `vibest.json`), reloaded when they change (OpenCode V2 `plugin/supervisor.ts`):
   * every relevant change closes readiness and lands in a capacity-1 sliding queue; after DEBOUNCE of quiet one consumer
   * re-reads and activates, so reloads never overlap. vibestd does not wait for the first activation; spawns do.
   */
  static readonly layer = Layer.effect(
    Plugins,
    Effect.gen(function* () {
      yield* (yield* PluginLoader).prepare
      const host = yield* makeHost()
      const sources = yield* makeSources(DEFAULT_TIMEOUT)
      const builtins = yield* Builtins
      const triggers = yield* Queue.sliding<void>(1)
      const changed = new Set<string>()
      let observed = 0
      host.ready.closeUnsafe()
      const notify = (file?: string) => {
        if (file !== undefined) changed.add(file)
        observed++
        host.ready.closeUnsafe()
        Queue.offerUnsafe(triggers, undefined)
      }
      const watcher = yield* makeWatcher(notify)
      const scope = yield* Effect.scope
      const reload = Effect.gen(function* () {
        if (changed.size > 0) yield* Effect.log(`plugins: reloading after changes to ${[...changed].join(", ")}`)
        changed.clear()
        let read = yield* sources.read
        // Read again while the watched directories change: a change made before its watch began is not reported.
        let rewatched = false
        while (yield* watcher.update(read.watched)) {
          rewatched = true
          read = yield* sources.read
        }
        yield* host.activate([builtin, ...builtins, ...read.candidates])
        // ponytail: Bun 1.4's fs.watch on macOS sometimes drops other directories' events for a moment after a watch
        // closes (seen in 2–6% of tries); one more read RECHECK later catches those. Drop when Bun no longer does.
        if (rewatched)
          yield* Effect.sleep(RECHECK).pipe(Effect.andThen(Effect.sync(() => notify())), Effect.forkIn(scope))
      }).pipe(Effect.catchCause((cause) => Effect.logError("plugins: reload failed", cause)))
      yield* Stream.concat(Stream.succeed(undefined), Stream.fromQueue(triggers).pipe(Stream.debounce(DEBOUNCE))).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const target = observed
            yield* reload
            // A change during the reload queued another one; readiness stays closed until that settles.
            if (observed === target) host.ready.openUnsafe()
          }),
        ),
        Effect.forkScoped,
      )
      return host.service
    }),
  )
}
