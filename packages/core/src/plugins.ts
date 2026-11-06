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

import { type Candidate, makeSources, makeWatcher, messageOf, PluginLoader } from "./plugin-sources.ts"
import { machinesListing, Runtimes } from "./runtimes.ts"
import { Subscriptions } from "./subscriptions/service.ts"
export { AgentRefused, Change, HookFailed, PluginInfo, Routing, TraceEntry } from "@vibest/schema/plugin"

export { type Candidate, pluginEntries, PluginLoader } from "./plugin-sources.ts"

export const DEFAULT_TIMEOUT = Duration.seconds(5)
const ACTIVATION_WAIT = Duration.seconds(10)
const DEBOUNCE = Duration.millis(100)
const RECHECK = Duration.seconds(1)

type HookName = keyof VibestPlugin.Hooks

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

export type StartInput = Omit<VibestPlugin.AgentStartBefore, "subscriptions">

export type FailInput = Omit<VibestPlugin.AgentFail, "subscriptions" | "move">

export interface SpawnDecision extends Routing {
  readonly prompt: string
  readonly harness: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
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
type HookBuckets = { [N in HookName]: Array<Registered<N>> }
const emptyBuckets = (): HookBuckets => ({ "agent.start.before": [], "agent.fail": [] })
type Loaded = Candidate & { readonly plugin: VibestPlugin.Plugin.Plugin }
export const Builtins = Context.Reference<ReadonlyArray<Candidate>>("vibest/Plugins/Builtins", {
  defaultValue: () => [],
})
type Running = { readonly candidate: Loaded; readonly scope: Scope.Closeable; readonly hooks: HookBuckets }
type Slot = {
  readonly candidate: Candidate
  readonly running: Running | undefined
  readonly failure: string | undefined
  readonly rollback?: string
  readonly setupFailed: boolean
  readonly loadedAt: number
  readonly stats: Stats
}

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

type Stopped = { readonly plugin: string; readonly reason: string }

export const makeHost = (options: { readonly timeout?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const root = yield* Effect.scope
    const ready = yield* Latch.make(true)
    let slots: ReadonlyArray<Slot> = []
    let dispatching = 0
    const idle = yield* Latch.make(true)

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
      const bind = (
        prefix: "agent",
        register: {
          [S in VibestPlugin.HookOf<"agent">]: (
            callback: HookFn<Extract<`agent.${S}`, HookName>>,
          ) => Effect.Effect<void, never, Scope.Scope>
        },
      ): VibestPlugin.Domain<"agent"> => ({
        hook: <S extends VibestPlugin.HookOf<"agent">>(short: S, callback: HookFn<Extract<`agent.${S}`, HookName>>) => {
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
      const outcome =
        "error" in plugin
          ? plugin.error
          : unchanged && previous.setupFailed
            ? previous.failure!
            : yield* setUp({ ...candidate, plugin }, stats)
      if (typeof outcome !== "string") return { ...base, running: outcome }
      const failed: Slot = { ...base, failure: outcome, setupFailed: !("error" in plugin) }
      const last = previous?.running?.candidate
      if (last === undefined) {
        return unchanged && previous.rollback !== undefined ? { ...failed, rollback: previous.rollback } : failed
      }
      const restored = ids.has(last.plugin.id) ? `Duplicate plugin ID: ${last.plugin.id}` : yield* setUp(last, stats)
      return typeof restored === "string"
        ? { ...failed, rollback: `revision ${last.revision} not restored: ${restored}` }
        : { ...failed, running: restored }
    })

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
      slots = slots.slice(0, prefix)
      yield* idle.await
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

    const settled = ready.await.pipe(Effect.timeoutOption(ACTIVATION_WAIT), Effect.map(Option.isSome))

    const bucket = <N extends HookName>(hooks: ReadonlyArray<HookBuckets>, name: N) => hooks.flatMap((set) => set[name])

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

    const refusal = (stopped: Stopped) => new AgentRefused({ plugin: stopped.plugin, reason: stopped.reason })

    const failure = (stopped: Stopped) => new HookFailed({ message: stopped.reason })

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
    readonly start: (input: StartInput) => Effect.Effect<SpawnDecision, AgentRefused>
    readonly fail: (
      input: FailInput,
    ) => Effect.Effect<
      { readonly move: VibestPlugin.AgentFail["move"]; readonly trace: ReadonlyArray<TraceEntry> },
      HookFailed
    >
    readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
  }
>()("vibest/Plugins") {
  static readonly make = (candidates: ReadonlyArray<Candidate>, options: { readonly timeout?: Duration.Input } = {}) =>
    makeHost(options).pipe(
      Effect.tap((host) => host.activate(candidates)),
      Effect.map((host) => host.service),
    )

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
        let rewatched = false
        while (yield* watcher.update(read.watched)) {
          rewatched = true
          read = yield* sources.read
        }
        yield* host.activate([...builtins, ...read.candidates])
        if (rewatched)
          yield* Effect.sleep(RECHECK).pipe(Effect.andThen(Effect.sync(() => notify())), Effect.forkIn(scope))
      }).pipe(Effect.catchCause((cause) => Effect.logError("plugins: reload failed", cause)))
      yield* Stream.concat(Stream.succeed(undefined), Stream.fromQueue(triggers).pipe(Stream.debounce(DEBOUNCE))).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const target = observed
            yield* reload
            if (observed === target) host.ready.openUnsafe()
          }),
        ),
        Effect.forkScoped,
      )
      return host.service
    }),
  )
}
