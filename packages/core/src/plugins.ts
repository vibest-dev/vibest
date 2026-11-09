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

import { Harnesses } from "./harness.ts"
import type { PluginsShape } from "./host.ts"
import { type Candidate, makeSources, makeWatcher, messageOf, PluginLoader } from "./plugin-sources.ts"
import * as Registry from "./registry.ts"
import { machinesListing, Runtimes } from "./runtimes.ts"
import { Subscriptions } from "./subscriptions/service.ts"
export { AgentRefused, Change, HookFailed, PluginInfo, Routing, TraceEntry } from "@vibest/schema/plugin"

export { type Candidate, pluginEntries, PluginLoader } from "./plugin-sources.ts"

export const DEFAULT_TIMEOUT = Duration.seconds(5)
export const MACHINE_TIMEOUT = Duration.seconds(30)
const ACTIVATION_WAIT = Duration.seconds(10)
const DEBOUNCE = Duration.millis(100)
const RECHECK = Duration.seconds(1)

type Short = keyof VibestPlugin.AgentHooks
type HookName = `agent.${Short}`
type EventOf<N extends HookName> = N extends `agent.${infer S extends Short}` ? VibestPlugin.AgentHooks[S] : never
type ErrorOf<N extends HookName> = N extends `agent.${infer S extends Short}` ? VibestPlugin.AgentFailures[S] : never

export type MachineHook = keyof VibestPlugin.MachineHooks
export type MachineEventInput = Omit<VibestPlugin.MachineEvent, "notes">
export interface PluginNote extends VibestPlugin.MachineNote {
  readonly plugin?: string
}

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
type HookFn<N extends HookName> = (event: EventOf<N>) => Effect.Effect<void, ErrorOf<N>>
type Registered<N extends HookName> = {
  readonly plugin: string
  readonly stats: Stats
  readonly callback: HookFn<N>
}
type HookBuckets = { [N in HookName]: ReadonlyArray<Registered<N>> }
type MachineRegistered = {
  readonly plugin: string
  readonly name: MachineHook
  readonly runtime: string | undefined
  readonly scope: Scope.Scope
  readonly stats: Stats
  readonly callback: (event: VibestPlugin.MachineEvent) => Effect.Effect<void>
}
const emptyBuckets = (): HookBuckets => ({ "agent.start.before": [], "agent.fail": [] })
const HOOKS: ReadonlyArray<Short> = ["start.before", "fail"]
type Loaded = Candidate & { readonly plugin: VibestPlugin.Plugin.Plugin }
export const Builtins = Context.Reference<ReadonlyArray<Candidate>>("vibest/Plugins/Builtins", {
  defaultValue: () => [],
})
type Running = {
  readonly candidate: Loaded
  readonly scope: Scope.Closeable
  hooks: HookBuckets
  machine: ReadonlyArray<MachineRegistered>
  broken: string | undefined
}
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
  const { candidate } = slot
  const running = slot.running?.broken === undefined ? slot.running : undefined
  const failure = slot.running?.broken ?? slot.failure
  const shown = slot.running?.candidate ?? candidate
  return {
    id: slot.running?.candidate.plugin.id ?? ("error" in candidate.plugin ? candidate.source : candidate.plugin.id),
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

type Broken = { readonly running: Running; readonly refresh: Effect.Effect<void> }

export const makeHost = (options: { readonly timeout?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const root = yield* Effect.scope
    const ready = yield* Latch.make(true)
    let slots: ReadonlyArray<Slot> = []

    const close = (scope: Scope.Closeable, id: string) =>
      runBounded(Scope.close(scope, Exit.void), root, timeout).pipe(
        Effect.flatMap((exit) =>
          Option.isNone(exit)
            ? Effect.logWarning(`plugin ${id}: teardown timed out; left to finish on its own`)
            : Effect.void,
        ),
      )

    const broken = yield* Queue.unbounded<Broken>()
    yield* Stream.fromQueue(broken).pipe(
      Stream.runForEach(({ running, refresh }) =>
        Effect.logWarning(`plugin ${running.candidate.plugin.id} disabled: ${running.broken}`).pipe(
          Effect.andThen(close(running.scope, running.candidate.plugin.id)),
          Effect.andThen(refresh),
          Effect.catchCause((cause) => Effect.logError("plugins: disabling a plugin failed", cause)),
        ),
      ),
      Effect.forkIn(root),
    )

    const subscriptions = yield* Subscriptions
    const runtimes = yield* Runtimes
    const harnesses = yield* Harnesses
    const setUp = Effect.fnUntraced(function* (candidate: Loaded, stats: Stats) {
      const plugin = candidate.plugin
      const scope = yield* Scope.fork(root)
      const running: Running = { candidate, scope, hooks: emptyBuckets(), machine: [], broken: undefined }
      const remember = <N extends HookName>(name: N, callback: HookFn<N>) =>
        Effect.gen(function* () {
          const entry: Registered<N> = { plugin: plugin.id, stats, callback }
          const hooks: HookBuckets = { ...running.hooks, [name]: [...running.hooks[name], entry] }
          running.hooks = hooks
          const dispose = Effect.sync(() => {
            const list: ReadonlyArray<Registered<N>> = running.hooks[name]
            if (!list.includes(entry)) return
            running.hooks = { ...running.hooks, [name]: list.filter((e) => e !== entry) }
          })
          yield* Effect.addFinalizer(() => dispose)
          return { dispose } satisfies VibestPlugin.Registration
        })
      const hook: VibestPlugin.AgentDomain["hook"] = (short, callback) => {
        if (typeof short !== "string" || !HOOKS.includes(short)) {
          return Effect.die(
            new Error(
              `unsupported hook ${JSON.stringify(`agent.${String(short)}`)}; supported: ${HOOKS.map((s) => `agent.${s}`).join(", ")}`,
            ),
          )
        }
        return remember(`agent.${short}`, callback as unknown as HookFn<HookName>)
      }
      const machine: VibestPlugin.MachineDomain["hook"] = (name, callback, options) => {
        if (name !== "connect" && name !== "remove")
          return Effect.die(
            new Error(
              `unsupported hook ${JSON.stringify(`machine.${String(name)}`)}; supported: machine.connect, machine.remove`,
            ),
          )
        return Effect.gen(function* () {
          const entry: MachineRegistered = {
            plugin: plugin.id,
            name,
            runtime: options?.runtime,
            scope,
            stats,
            callback,
          }
          running.machine = [...running.machine, entry]
          const dispose = Effect.sync(() => {
            running.machine = running.machine.filter((e) => e !== entry)
          })
          yield* Effect.addFinalizer(() => dispose)
          return { dispose } satisfies VibestPlugin.Registration
        })
      }
      const context: VibestPlugin.Context = {
        options: candidate.options,
        agent: { hook },
        machine: { hook: machine },
        runtime: { transform: runtimes.transform, reload: runtimes.reload },
        harness: { transform: harnesses.transform, reload: harnesses.reload },
        subscription: { report: (input) => subscriptions.report(input) },
      }
      const report = (failure: Registry.Failure, refresh: Effect.Effect<void>) => {
        running.broken = `${failure.state}.transform threw: ${messageOf(failure.cause)}`
        Queue.offerUnsafe(broken, { running, refresh })
      }
      const exit = yield* runBounded(
        plugin.effect(context).pipe(Scope.provide(scope), Registry.group(report)),
        scope,
        timeout,
      )
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

    const activate = (candidates: ReadonlyArray<Candidate>) =>
      Registry.batch(
        Effect.gen(function* () {
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
        }),
      )

    yield* Effect.addFinalizer(() =>
      Registry.shutdown(
        Effect.forEach(
          slots.toReversed(),
          (slot) => (slot.running ? close(slot.running.scope, slot.running.candidate.plugin.id) : Effect.void),
          { discard: true },
        ),
      ),
    )

    const settled = ready.await.pipe(Effect.timeoutOption(ACTIVATION_WAIT), Effect.map(Option.isSome))

    const runHook = Effect.fnUntraced(function* <N extends HookName>(
      hooks: ReadonlyArray<Registered<N>>,
      name: N,
      event: EventOf<N>,
      trace: Array<TraceEntry>,
      decidedBy: Record<string, string> = {},
    ) {
      for (const hook of hooks) {
        const before = { ...event }
        const started = yield* Clock.currentTimeMillis
        const exit = yield* runBounded(hook.callback(event), root, timeout).pipe(
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

    const hooksOf = <N extends HookName>(name: N): ReadonlyArray<Registered<N>> =>
      slots.flatMap((s) => (s.running && s.running.broken === undefined ? s.running.hooks[name] : []))

    const withHooks = <A, E>(name: string, f: (trace: Array<TraceEntry>) => Effect.Effect<A, E>) =>
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
        return yield* f(trace)
      })

    const start = Effect.fn("Plugins.start")(function* (input: StartInput) {
      return yield* withHooks("agent.start.before", (trace) =>
        Effect.gen(function* () {
          const hooks = hooksOf("agent.start.before")
          const current = yield* subscriptions.list
          const machines = yield* machinesListing(runtimes, input.machines[0]?.harnesses ?? [])
          const event: VibestPlugin.AgentStartBefore = { ...input, machines, subscriptions: current }
          const decidedBy: Record<string, string> = {}
          const stopped = yield* runHook(hooks, "agent.start.before", event, trace, decidedBy)
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
      return yield* withHooks("agent.fail", (trace) =>
        Effect.gen(function* () {
          const hooks = hooksOf("agent.fail")
          const event: VibestPlugin.AgentFail = { ...input, subscriptions: yield* subscriptions.list, move: undefined }
          const stopped = yield* runHook(hooks, "agent.fail", event, trace)
          if (stopped !== undefined) return yield* failure(stopped)
          return { move: event.move, trace }
        }),
      )
    })

    const machine = Effect.fn("Plugins.machine")(function* (
      short: MachineHook,
      input: MachineEventInput,
      runtime?: string,
    ) {
      const name = `machine.${short}`
      return yield* withHooks(name, () =>
        Effect.gen(function* () {
          const notes: Array<PluginNote> = []
          const ran: Array<string> = []
          const subscribers = slots.flatMap((s) =>
            s.running && s.running.broken === undefined
              ? s.running.machine.filter(
                  (hook) =>
                    hook.name === short &&
                    (runtime === undefined || hook.runtime === undefined || hook.runtime === runtime),
                )
              : [],
          )
          for (const hook of subscribers) {
            const own: Array<VibestPlugin.MachineNote> = []
            const exit = yield* runBounded(hook.callback({ ...input, notes: own }), hook.scope, MACHINE_TIMEOUT)
            hook.stats.calls++
            if (!ran.includes(hook.plugin)) ran.push(hook.plugin)
            notes.push(...own.map((note) => ({ plugin: hook.plugin, ...note })))
            const problem = Option.isNone(exit)
              ? `plugin ${hook.plugin} timed out after ${Duration.format(MACHINE_TIMEOUT)}`
              : Exit.isFailure(exit.value)
                ? `plugin ${hook.plugin} crashed: ${errorMessage(exit.value.cause)}`
                : undefined
            if (problem === undefined) continue
            if (Option.isNone(exit)) hook.stats.timedOut++
            else hook.stats.crashed++
            hook.stats.lastError = problem
            notes.push({ plugin: hook.plugin, message: problem })
            yield* Effect.logWarning(`${name} ${input.name}: ${problem}`)
          }
          return { plugins: ran, notes }
        }),
      )
    })

    const list = settled.pipe(Effect.andThen(Effect.sync(() => slots.map(info))))
    return { service: Plugins.of({ start, fail, list, settled, machine }), activate, ready }
  })

export class Plugins extends Context.Service<Plugins, PluginsShape>()("vibest/Plugins") {
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
      yield* host.activate(builtins)
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
