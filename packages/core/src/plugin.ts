import * as VibestPlugin from "@vibest/plugin/effect"
import { fromPromise } from "@vibest/plugin/promise/adapter"
import { messageOf } from "@vibest/schema/error"
import { AgentRefused, type Change, HookFailed, PluginInfo, PluginsNotActive, TraceEntry } from "@vibest/schema/plugin"
import { Clock, Context, Duration, Effect, Exit, Latch, Layer, Option, Queue, Scope, Stream } from "effect"

import { Agents } from "./agents.ts"
import { Bus } from "./bus.ts"
import { timeoutWithoutWaiting } from "./effect/bounded.ts"
import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"
import { Harnesses } from "./harness.ts"
import * as Hooks from "./plugin/hooks.ts"
import { errorMessage } from "./plugin/hooks.ts"
import * as PluginHost from "./plugin/host.ts"
import * as Registry from "./plugin/registry.ts"
import {
  type FailInput,
  Plugins,
  type StartInput,
  type MachineHook,
  type PluginNote,
  type SpawnDecision,
} from "./plugin/service.ts"
import { type AnyPlugin, type Candidate, keyOf, makeSources, PluginLoader } from "./plugin/sources.ts"
import { supervise } from "./plugin/supervisor.ts"
import { logFailure } from "./reactor.ts"
import { machinesListing, Runtimes } from "./runtimes.ts"
import { Subscriptions } from "./subscriptions/service.ts"
export {
  AgentRefused,
  Change,
  HookFailed,
  PluginInfo,
  PluginsNotActive,
  Routing,
  TraceEntry,
} from "@vibest/schema/plugin"

export { type Candidate, pluginEntries, PluginLoader } from "./plugin/sources.ts"
export { DEBOUNCE, RECHECK } from "./plugin/supervisor.ts"
export { errorMessage }
export type { FailInput, Interface, MachineHook, PluginNote, SpawnDecision, StartInput } from "./plugin/service.ts"
export { Plugins } from "./plugin/service.ts"

export const DEFAULT_TIMEOUT = Duration.seconds(5)
export const MACHINE_TIMEOUT = Duration.seconds(30)
const ACTIVATION_WAIT = Duration.seconds(10)

type Stats = Hooks.Stats
const effectOf = (plugin: AnyPlugin) => ("effect" in plugin ? plugin.effect : fromPromise(plugin))

type Loaded = Candidate & { readonly plugin: AnyPlugin }
export const Builtins = Context.Reference<ReadonlyArray<Candidate>>("vibest/Plugins/Builtins", {
  defaultValue: () => [],
})
export const builtinsNode = LayerNode.make({ service: Builtins, layer: Layer.succeed(Builtins, []), deps: [] })
type Running = {
  readonly candidate: Loaded
  readonly scope: Scope.Closeable
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

const info = (slot: Slot): PluginInfo => {
  const { candidate } = slot
  const running = slot.running?.broken === undefined ? slot.running : undefined
  const failure = slot.running?.broken ?? slot.importFailed?.error ?? slot.failure
  const failedRevision = slot.importFailed?.revision ?? candidate.revision
  const shown = slot.running?.candidate ?? candidate
  return {
    id: slot.running?.candidate.plugin.id ?? ("error" in candidate.plugin ? candidate.source : candidate.plugin.id),
    source: candidate.source,
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

const routed = (before: VibestPlugin.AgentStartBefore, after: VibestPlugin.AgentStartBefore) =>
  ROUTE.filter(
    (field) =>
      JSON.stringify(before[field]) !== JSON.stringify(after[field]) &&
      (after[field] !== undefined || !REQUIRED.includes(field)),
  )

const readOnly = <T extends object>(event: T): T => Object.freeze(structuredClone(event))

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

type Broken = { readonly running: Running; readonly refresh: Effect.Effect<void> }

const idOf = (candidate: Candidate): string => ("error" in candidate.plugin ? candidate.source : candidate.plugin.id)

export const makeHost = (options: { readonly timeout?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const root = yield* Effect.scope
    const ready = yield* Latch.make(true)
    const holds = new Set<object>()
    let closed = false
    let slots: ReadonlyArray<Slot> = []
    let pending: ReadonlyArray<string> = []
    let loading: ReadonlyArray<string> = []
    const holdNow = () => {
      if (closed) return Effect.void
      const token = {}
      holds.add(token)
      ready.closeUnsafe()
      return Effect.sync(() => {
        if (holds.delete(token) && holds.size === 0 && !closed) ready.openUnsafe()
      })
    }

    const close = (scope: Scope.Closeable, id: string, level: "error" | "warning" = "error") =>
      timeoutWithoutWaiting(Scope.close(scope, Exit.void), root, timeout).pipe(
        Effect.flatMap((exit) =>
          Option.isNone(exit)
            ? Effect.logWarning(`plugin ${id}: teardown timed out; left to finish on its own`)
            : Exit.isFailure(exit.value)
              ? (level === "error" ? Effect.logError : Effect.logWarning)(
                  "failed to clean up plugin",
                  { "plugin.id": id },
                  exit.value.cause,
                )
              : Effect.void,
        ),
      )

    const broken = yield* Queue.unbounded<Broken>()
    yield* Stream.fromQueue(broken).pipe(
      Stream.runForEach(({ running, refresh }) =>
        Effect.logWarning(`plugin ${running.candidate.plugin.id} disabled: ${running.broken}`).pipe(
          Effect.andThen(close(running.scope, running.candidate.plugin.id, "warning")),
          Effect.andThen(refresh),
          logFailure("plugins: disabling a plugin failed"),
        ),
      ),
      Effect.forkIn(root),
    )

    const subscriptions = yield* Subscriptions
    const runtimes = yield* Runtimes
    const hooks = yield* Hooks.Service
    const contextFor = yield* PluginHost.make
    const setUp = Effect.fnUntraced(function* (candidate: Loaded, stats: Stats) {
      const plugin = candidate.plugin
      const scope = yield* Scope.fork(root)
      const running: Running = { candidate, scope, broken: undefined }
      const report = (failure: Registry.Failure, refresh: Effect.Effect<void>) => {
        running.broken = `${failure.state}.transform threw: ${messageOf(failure.cause)}`
        Queue.offerUnsafe(broken, { running, refresh })
      }
      const exit = yield* timeoutWithoutWaiting(
        Effect.suspend(() =>
          effectOf(plugin)(contextFor({ plugin: plugin.id, activation: running, options: candidate.options, stats })),
        ).pipe(Scope.provide(scope), Registry.group(report)),
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
          pending = candidates.map(idOf)
          loading = []
          slots = slots.map((slot) => ({ ...slot, importFailed: failures.get(slot.candidate.source) }))
          let prefix = 0
          while (
            prefix < candidates.length &&
            prefix < slots.length &&
            keyOf(slots[prefix]!.candidate) === keyOf(candidates[prefix]!)
          )
            prefix++
          slots = slots.map((slot, i) => (i < prefix ? { ...slot, candidate: candidates[i]! } : slot))
          if (prefix === candidates.length && prefix === slots.length) return
          const retired = slots.slice(prefix)
          slots = slots.slice(0, prefix)
          for (const slot of retired.toReversed())
            if (slot.running) yield* close(slot.running.scope, slot.running.candidate.plugin.id)
          const ids = new Set(slots.flatMap((s) => (s.running ? [s.running.candidate.plugin.id] : [])))
          for (const candidate of candidates.slice(prefix)) {
            const slot = yield* build(
              candidate,
              retired.find((s) => idOf(s.candidate) === idOf(candidate)),
              ids,
            )
            if (slot.running) ids.add(slot.running.candidate.plugin.id)
            slots = [...slots, { ...slot, importFailed: failures.get(candidate.source) }]
          }
        }).pipe(Effect.ensuring(Effect.sync(() => (pending = [])))),
      )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
        holds.clear()
        ready.openUnsafe()
      }).pipe(
        Effect.andThen(
          Registry.shutdown(
            Effect.forEach(
              slots.toReversed(),
              (slot) => (slot.running ? close(slot.running.scope, slot.running.candidate.plugin.id) : Effect.void),
              { discard: true },
            ),
          ),
        ),
      ),
    )

    const settled = ready.await.pipe(Effect.timeoutOption(ACTIVATION_WAIT), Effect.map(Option.isSome))
    const stillLoading = () => {
      const placed = new Set(slots.map((slot) => idOf(slot.running?.candidate ?? slot.candidate)))
      return [...new Set([...loading, ...pending].filter((id) => !placed.has(id)))]
    }
    const admit = <N extends Hooks.Name>(name: N, runtime?: string) =>
      Effect.gen(function* () {
        if (!(yield* settled)) return yield* new PluginsNotActive({ plugins: stillLoading() })
        return hooksOf(name, runtime)
      })

    const refusal = (stopped: Hooks.Stopped) => new AgentRefused({ plugin: stopped.plugin, reason: stopped.reason })

    const failure = (stopped: Hooks.Stopped) => new HookFailed({ message: stopped.reason })

    const hooksOf = <N extends Hooks.Name>(name: N, runtime?: string): ReadonlyArray<Hooks.Entry<N>> =>
      slots.flatMap((s) => (s.running && s.running.broken === undefined ? hooks.get(name, runtime, s.running) : []))

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
      const trace: Array<TraceEntry> = []
      const entries = yield* admit("agent.start.before")
      return yield* Effect.gen(function* () {
        const current = yield* subscriptions.list
        const machines = yield* machinesListing(runtimes, input.machines[0]?.harnesses ?? [])
        const event: VibestPlugin.AgentStartBefore = { ...input, machines, subscriptions: current }
        const decidedBy: Record<string, string> = {}
        const route = (draft: VibestPlugin.AgentStartBefore, plugin: string) => {
          const fields = routed(event, draft)
          const values = Object.fromEntries(fields.map((field) => [field, structuredClone(draft[field])]))
          const changes = fields.map((field) => decide(field, event[field], values[field], plugin, decidedBy))
          Object.assign(event, values)
          return changes
        }
        const stopped = yield* Hooks.dispatch("agent.start.before", entries, event, route, trace, root, timeout)
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
      })
    })

    const fail = Effect.fn("Plugins.fail")(function* (input: FailInput) {
      const trace: Array<TraceEntry> = []
      const entries = yield* admit("agent.fail")
      return yield* Effect.gen(function* () {
        const event: VibestPlugin.AgentFail = { ...input, subscriptions: yield* subscriptions.list, move: undefined }
        const decidedBy: Record<string, string> = {}
        const moveTo = (draft: VibestPlugin.AgentFail, plugin: string) => {
          if (JSON.stringify(draft.move) === JSON.stringify(event.move)) return []
          const move = structuredClone(draft.move)
          const change = decide("move", event.move, move, plugin, decidedBy)
          event.move = move
          return [change]
        }
        const stopped = yield* Hooks.dispatch("agent.fail", entries, event, moveTo, trace, root, timeout)
        if (stopped !== undefined) return yield* failure(stopped)
        return { move: event.move, trace }
      })
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

    const list = Effect.sync(() => slots.map(info))
    const importing = (sources: ReadonlyArray<string>) => Effect.sync(() => void (loading = sources))
    return { service: Plugins.of({ start, fail, list, settled, machine }), activate, holdNow, importing }
  })

export const makePlugins = (
  candidates: ReadonlyArray<Candidate>,
  options: { readonly timeout?: Duration.Input } = {},
) =>
  makeHost(options).pipe(
    Effect.tap((host) => host.activate(candidates)),
    Effect.map((host) => host.service),
    Effect.provide(Hooks.Service.layer),
  )

export const pluginsLayer = Layer.effect(
  Plugins,
  Effect.gen(function* () {
    yield* (yield* PluginLoader).prepare
    const host = yield* makeHost()
    const sources = yield* makeSources(DEFAULT_TIMEOUT)
    const builtins = yield* Builtins
    yield* supervise(host, builtins, sources)
    return host.service
  }),
)

export const pluginsNode = LayerNode.make({
  service: Plugins,
  layer: pluginsLayer,
  deps: [
    builtinsNode,
    Agents.node,
    Bus.node,
    Harnesses.node,
    Hooks.Service.node,
    PluginLoader.node,
    Runtimes.node,
    Subscriptions.node,
    PlatformNode.crypto,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
