import * as VibestPlugin from "@vibest/plugin"
import { Catalog, type Fact, type FactOf, type FactType } from "@vibest/schema/event"
import { AgentRefused, type Change, HookFailed, PluginInfo, Routing, TraceEntry } from "@vibest/schema/plugin"
import { Cause, Clock, Context, Duration, Effect, Exit, Latch, Layer, Option, Queue, Scope, Stream } from "effect"

import { Agents } from "./agents.ts"
import { timeoutWithoutWaiting } from "./bounded.ts"
import { Bus, type EngineEvent } from "./bus.ts"
import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"
import { logFailure } from "./engine.ts"
import { Harnesses } from "./harness.ts"
import * as Hooks from "./hooks.ts"
import { errorMessage } from "./hooks.ts"
import type { PluginsShape } from "./host.ts"
import { type Candidate, makeSources, messageOf, PluginLoader } from "./plugin-sources.ts"
import { supervise } from "./plugin-supervisor.ts"
import * as Registry from "./registry.ts"
import { machinesListing, Runtimes } from "./runtimes.ts"
import { Subscriptions } from "./subscriptions/service.ts"
export { AgentRefused, Change, HookFailed, PluginInfo, Routing, TraceEntry } from "@vibest/schema/plugin"

export { type Candidate, pluginEntries, PluginLoader } from "./plugin-sources.ts"
export { DEBOUNCE, RECHECK } from "./plugin-supervisor.ts"
export { errorMessage }

export const DEFAULT_TIMEOUT = Duration.seconds(5)
export const MACHINE_TIMEOUT = Duration.seconds(30)
const ACTIVATION_WAIT = Duration.seconds(10)

type Short = keyof VibestPlugin.AgentHooks
type AgentHook = `agent.${Short}`

export type MachineHook = keyof VibestPlugin.MachineHooks
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

export type FailInput = Omit<VibestPlugin.AgentFail, "subscriptions">

export interface SpawnDecision extends Routing {
  readonly prompt: string
  readonly harness: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly machine: { readonly id: string }
  readonly runtime: string | undefined
}

type Stats = Hooks.Stats
const HOOKS: ReadonlyArray<Short> = ["start.before", "fail"]
type Loaded = Candidate & { readonly plugin: VibestPlugin.Plugin.Plugin }
export const Builtins = Context.Reference<ReadonlyArray<Candidate>>("vibest/Plugins/Builtins", {
  defaultValue: () => [],
})
export const builtinsNode = LayerNode.make({ service: Builtins, layer: Layer.succeed(Builtins, []), deps: [] })
type Running = {
  readonly candidate: Loaded
  readonly scope: Scope.Closeable
  readonly hooks: Hooks.Hooks
  broken: string | undefined
}
type ImportFailure = { readonly revision: string; readonly error: string }
type Slot = {
  readonly candidate: Candidate
  readonly running: Running | undefined
  readonly failure: string | undefined
  readonly rollback?: string
  readonly importFailed?: ImportFailure | undefined
  readonly setupFailed: boolean
  readonly loadedAt: number
  readonly stats: Stats
}

const keyOf = (c: Candidate) => JSON.stringify([c.source, c.revision, c.options])

const info = (slot: Slot): PluginInfo => {
  const { candidate } = slot
  const running = slot.running?.broken === undefined ? slot.running : undefined
  const failure = slot.running?.broken ?? slot.importFailed?.error ?? slot.failure
  const failedRevision = slot.importFailed?.revision ?? candidate.revision
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
            ? `revision ${failedRevision} failed, still running ${shown.revision}: ${failure}`
            : [failure, slot.rollback].filter(Boolean).join("; "),
        }),
    ...slot.stats,
  }
}

const ROUTE = ["prompt", "harness", "provider", "model", "machine", "runtime"] as const
const REQUIRED: ReadonlyArray<(typeof ROUTE)[number]> = ["prompt", "machine"]

const routed = (patch: VibestPlugin.AgentRoute) =>
  ROUTE.filter((field) => Object.hasOwn(patch, field) && (patch[field] !== undefined || !REQUIRED.includes(field)))

const readOnly = <T extends object>(event: T): T =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(event).map(([field, value]) => [
        field,
        value !== null && typeof value === "object"
          ? Object.freeze(Array.isArray(value) ? [...value] : { ...value })
          : value,
      ]),
    ),
  ) as T

const decide = (
  field: string,
  from: unknown,
  to: unknown,
  plugin: string,
  decidedBy: Record<string, string>,
): typeof Change.Type => {
  const change = {
    field,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(decidedBy[field] ? { overwrote: decidedBy[field] } : {}),
  }
  decidedBy[field] = plugin
  return change
}

const isFact = (event: EngineEvent): event is Fact => Object.hasOwn(Catalog, event.type)

const factsFor =
  (bus: Bus["Service"], plugin: string): VibestPlugin.EventDomain["subscribe"] =>
  <T extends FactType>(input?: { readonly types?: ReadonlyArray<T> }) => {
    const asked: ReadonlyArray<string> = input?.types ?? []
    const known = new Set(asked.filter((type) => Object.hasOwn(Catalog, type)))
    const unknown = asked.filter((type) => !known.has(type))
    const warned =
      unknown.length === 0
        ? Effect.void
        : Effect.logWarning(`plugin ${plugin} event.subscribe: ignoring unknown fact types ${unknown.join(", ")}`)
    if (asked.length > 0 && known.size === 0) return Stream.unwrap(Effect.as(warned, Stream.never))
    const wanted = (fact: Fact): fact is FactOf<T> => known.size === 0 || known.has(fact.type)
    return Stream.unwrap(Effect.andThen(warned, Effect.map(bus.subscribe, Stream.fromSubscription))).pipe(
      Stream.filter(isFact),
      Stream.filter(wanted),
      Stream.map((fact) => structuredClone(fact)),
    )
  }

type Stopped = { readonly plugin: string; readonly reason: string }

type Broken = { readonly running: Running; readonly refresh: Effect.Effect<void> }

export const makeHost = (options: { readonly timeout?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const root = yield* Effect.scope
    const ready = yield* Latch.make(true)
    let slots: ReadonlyArray<Slot> = []

    const close = (scope: Scope.Closeable, id: string) =>
      timeoutWithoutWaiting(Scope.close(scope, Exit.void), root, timeout).pipe(
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
          logFailure("plugins: disabling a plugin failed"),
        ),
      ),
      Effect.forkIn(root),
    )

    const subscriptions = yield* Subscriptions
    const runtimes = yield* Runtimes
    const harnesses = yield* Harnesses
    const agents = yield* Agents
    const bus = yield* Bus
    const setUp = Effect.fnUntraced(function* (candidate: Loaded, stats: Stats) {
      const plugin = candidate.plugin
      const scope = yield* Scope.fork(root)
      const running: Running = { candidate, scope, hooks: Hooks.make(), broken: undefined }
      const register = <N extends Hooks.Name>(
        name: N,
        callback: Hooks.Entry<N>["callback"],
        runtime: string | undefined = undefined,
      ) => running.hooks.register(name, { plugin: plugin.id, stats, runtime, callback })
      const hook: VibestPlugin.AgentDomain["hook"] = (short, callback) => {
        if (typeof short !== "string" || !HOOKS.includes(short)) {
          return Effect.die(
            new Error(
              `unsupported hook ${JSON.stringify(`agent.${String(short)}`)}; supported: ${HOOKS.map((s) => `agent.${s}`).join(", ")}`,
            ),
          )
        }
        return register(`agent.${short as Short}`, callback as unknown as Hooks.Entry<AgentHook>["callback"])
      }
      const machine: VibestPlugin.MachineDomain["hook"] = (name, callback, options) => {
        if (name !== "connect" && name !== "remove")
          return Effect.die(
            new Error(
              `unsupported hook ${JSON.stringify(`machine.${String(name)}`)}; supported: machine.connect, machine.remove`,
            ),
          )
        return register(`machine.${name}`, callback, options?.runtime)
      }
      const context: VibestPlugin.Context = {
        options: candidate.options,
        agent: { hook, transform: agents.transform },
        machine: { hook: machine },
        runtime: { transform: runtimes.transform, reload: runtimes.reload },
        harness: { transform: harnesses.transform, reload: harnesses.reload },
        subscription: { report: (input) => subscriptions.report(input) },
        event: { subscribe: factsFor(bus, plugin.id) },
      }
      const report = (failure: Registry.Failure, refresh: Effect.Effect<void>) => {
        running.broken = `${failure.state}.transform threw: ${messageOf(failure.cause)}`
        Queue.offerUnsafe(broken, { running, refresh })
      }
      const exit = yield* timeoutWithoutWaiting(
        Effect.suspend(() => VibestPlugin.Plugin.effectOf(plugin)(context)).pipe(
          Scope.provide(scope),
          Registry.group(report),
        ),
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
      const disabled = unchanged ? previous.running?.broken : undefined
      if (disabled !== undefined) return { ...base, failure: disabled, setupFailed: true }
      const outcome =
        "error" in plugin
          ? plugin.error
          : unchanged && previous.setupFailed
            ? previous.failure!
            : yield* setUp({ ...candidate, plugin }, stats)
      if (typeof outcome !== "string") return { ...base, running: outcome }
      const failed: Slot = { ...base, failure: outcome, setupFailed: !("error" in plugin) }
      const last = "error" in plugin ? undefined : previous?.running?.candidate
      if (last === undefined) {
        return unchanged && previous.rollback !== undefined ? { ...failed, rollback: previous.rollback } : failed
      }
      const restored = ids.has(last.plugin.id) ? `Duplicate plugin ID: ${last.plugin.id}` : yield* setUp(last, stats)
      return typeof restored === "string"
        ? { ...failed, rollback: `revision ${last.revision} not restored: ${restored}` }
        : { ...failed, running: restored }
    })

    const keepRunning = (incoming: ReadonlyArray<Candidate>) => {
      const failures = new Map<string, ImportFailure>()
      const candidates = incoming.map((candidate) => {
        if (!("error" in candidate.plugin)) return candidate
        const kept = slots.find(
          (s) =>
            s.running !== undefined &&
            s.candidate.source === candidate.source &&
            JSON.stringify(s.candidate.options) === JSON.stringify(candidate.options),
        )
        if (kept === undefined) return candidate
        failures.set(candidate.source, { revision: candidate.revision, error: candidate.plugin.error })
        return kept.candidate
      })
      return { candidates, failures }
    }

    const activate = (incoming: ReadonlyArray<Candidate>) =>
      Registry.batch(
        Effect.gen(function* () {
          const { candidates, failures } = keepRunning(incoming)
          slots = slots.map((slot) => ({ ...slot, importFailed: failures.get(slot.candidate.source) }))
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
            slots = [...slots, { ...slot, importFailed: failures.get(candidate.source) }]
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

    const runHook = Effect.fnUntraced(function* <N extends AgentHook>(
      name: N,
      event: () => Hooks.Events[N],
      apply: (value: Hooks.Results[N], plugin: string) => ReadonlyArray<typeof Change.Type>,
      trace: Array<TraceEntry>,
    ) {
      for (const hook of hooksOf(name)) {
        const ran = yield* Hooks.run(name, hook, readOnly(event()), root, timeout)
        const entry = { plugin: hook.plugin, hook: name, ms: ran.ms, changes: [] }
        if (ran.outcome === "timeout") {
          trace.push({ ...entry, outcome: "timeout", error: ran.error })
          yield* Effect.logWarning(`plugin ${hook.plugin} ${name}: ${ran.error}`)
          return { plugin: hook.plugin, reason: ran.error } satisfies Stopped
        }
        if (ran.outcome === "refused") {
          trace.push({ ...entry, outcome: "refused", reason: ran.reason })
          yield* Effect.log(`plugin ${hook.plugin} ${name}: refused (${ran.reason})`)
          return { plugin: hook.plugin, reason: ran.reason } satisfies Stopped
        }
        if (ran.outcome === "crashed") {
          trace.push({ ...entry, outcome: "crashed", error: ran.error })
          yield* Effect.logWarning(`plugin ${hook.plugin} ${name} crashed: ${Cause.pretty(ran.cause)}`)
          return { plugin: hook.plugin, reason: `plugin ${hook.plugin} crashed: ${ran.error}` } satisfies Stopped
        }
        const changes = ran.value === undefined ? [] : apply(ran.value, hook.plugin)
        if (changes.length > 0) hook.stats.changed++
        trace.push({ ...entry, outcome: "ok", changes })
        const summary =
          changes
            .map((c) => `${c.field} ${JSON.stringify(c.from) ?? "-"} → ${JSON.stringify(c.to) ?? "-"}`)
            .join(", ") || "no change"
        yield* Effect.log(`plugin ${hook.plugin} ${name}: ${summary} (${ran.ms} ms)`)
      }
      return undefined
    })

    const refusal = (stopped: Stopped) => new AgentRefused({ plugin: stopped.plugin, reason: stopped.reason })

    const failure = (stopped: Stopped) => new HookFailed({ message: stopped.reason })

    const hooksOf = <N extends Hooks.Name>(name: N, runtime?: string): ReadonlyArray<Hooks.Entry<N>> =>
      slots.flatMap((s) => (s.running && s.running.broken === undefined ? s.running.hooks.get(name, runtime) : []))

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
          const current = yield* subscriptions.list
          const machines = yield* machinesListing(runtimes, input.machines[0]?.harnesses ?? [])
          let event: VibestPlugin.AgentStartBefore = { ...input, machines, subscriptions: current }
          const decidedBy: Record<string, string> = {}
          const route = (patch: VibestPlugin.AgentRoute, plugin: string) => {
            const fields = routed(patch)
            const changes = fields.map((field) => decide(field, event[field], patch[field], plugin, decidedBy))
            event = { ...event, ...Object.fromEntries(fields.map((field) => [field, patch[field]])) }
            return changes
          }
          const stopped = yield* runHook("agent.start.before", () => event, route, trace)
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
          const event: VibestPlugin.AgentFail = { ...input, subscriptions: yield* subscriptions.list }
          const decidedBy: Record<string, string> = {}
          let move: VibestPlugin.AgentMove | undefined
          const moveTo = (next: VibestPlugin.AgentMove, plugin: string) => {
            const change = decide("move", move, next, plugin, decidedBy)
            move = next
            return [change]
          }
          const stopped = yield* runHook("agent.fail", () => event, moveTo, trace)
          if (stopped !== undefined) return yield* failure(stopped)
          return { move, trace }
        }),
      )
    })

    const machine = Effect.fn("Plugins.machine")(function* (
      short: MachineHook,
      input: VibestPlugin.MachineEvent,
      runtime?: string,
    ) {
      const name = `machine.${short}` as const
      return yield* withHooks(name, () =>
        Effect.gen(function* () {
          const notes: Array<PluginNote> = []
          const ran: Array<string> = []
          for (const hook of hooksOf(name, runtime)) {
            const result = yield* Hooks.run(name, hook, readOnly(input), root, MACHINE_TIMEOUT)
            if (!ran.includes(hook.plugin)) ran.push(hook.plugin)
            if (result.outcome === "ok" && Array.isArray(result.value))
              notes.push(...result.value.map((note) => ({ plugin: hook.plugin, ...note })))
            if (result.outcome !== "timeout" && result.outcome !== "crashed") continue
            const problem =
              result.outcome === "timeout" ? result.error : `plugin ${hook.plugin} crashed: ${result.error}`
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
      yield* supervise(host, builtins, sources)
      return host.service
    }),
  )

  static readonly node = LayerNode.make({
    service: Plugins,
    layer: Plugins.layer,
    deps: [
      builtinsNode,
      Agents.node,
      Bus.node,
      Harnesses.node,
      PluginLoader.node,
      Runtimes.node,
      Subscriptions.node,
      PlatformNode.crypto,
      PlatformNode.fileSystem,
      PlatformNode.layout,
      PlatformNode.path,
    ],
  })
}
