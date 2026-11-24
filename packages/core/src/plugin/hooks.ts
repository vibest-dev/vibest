import type * as VibestPlugin from "@vibest/plugin/effect"
import { messageOf } from "@vibest/schema/error"
import type { Change, TraceEntry } from "@vibest/schema/plugin"
import { Cause, Clock, Context, Duration, Effect, Exit, Layer, Option, Predicate, type Scope } from "effect"

import { Bounded } from "../effect/bounded.ts"
import { LayerNode } from "../effect/layer-node.ts"

export * as Hooks from "./hooks.ts"

export interface Events {
  readonly "session.start.before": VibestPlugin.SessionStartBefore
  readonly "session.tool.execute.before": VibestPlugin.SessionToolExecuteBefore
  readonly "machine.connect": VibestPlugin.MachineEvent
  readonly "machine.remove": VibestPlugin.MachineEvent
}

export interface Results extends Record<keyof Events, unknown> {
  readonly "session.start.before": void
  readonly "session.tool.execute.before": void
  readonly "machine.connect": ReadonlyArray<VibestPlugin.MachineNote>
  readonly "machine.remove": ReadonlyArray<VibestPlugin.MachineNote>
}

interface Failures extends Record<keyof Events, unknown> {
  readonly "session.start.before": VibestPlugin.SessionRefused
  readonly "session.tool.execute.before": VibestPlugin.ToolRefused
  readonly "machine.connect": never
  readonly "machine.remove": never
}

export type Name = keyof Events

export type Stats = {
  calls: number
  changed: number
  crashed: number
  timedOut: number
  refused: number
  lastError: string | undefined
}

export interface Activation {
  readonly scope: Scope.Scope
}

export type Entry<N extends Name> = {
  readonly plugin: string
  readonly activation: Activation
  readonly stats: Stats
  readonly runtime: string | undefined
  readonly callback: (event: Events[N]) => Effect.Effect<Results[N] | void, Failures[N]>
}

type Table = { readonly [N in Name]: ReadonlyArray<Entry<N>> }

export type Outcome<N extends Name> = { readonly ms: number } & (
  | { readonly outcome: "ok"; readonly value: Results[N] | undefined }
  | { readonly outcome: "refused"; readonly reason: string }
  | { readonly outcome: "timeout"; readonly error: string }
  | { readonly outcome: "crashed"; readonly error: string; readonly cause: Cause.Cause<unknown> }
)

export const errorMessage = (cause: Cause.Cause<unknown>) => messageOf(Cause.squash(cause))

const REFUSAL_TAG: Partial<Record<Name, "SessionRefused" | "ToolRefused">> = {
  "session.start.before": "SessionRefused",
  "session.tool.execute.before": "ToolRefused",
}

const isRefusal =
  (tag: "SessionRefused" | "ToolRefused") =>
  (e: unknown): e is VibestPlugin.SessionRefused | VibestPlugin.ToolRefused =>
    Predicate.isTagged(e, tag)

const decision = <A>(value: A | void) => (Predicate.isObjectOrArray(value) ? value : undefined)

export interface Interface {
  readonly register: <N extends Name>(
    name: N,
    entry: Entry<N>,
  ) => Effect.Effect<VibestPlugin.Registration, never, Scope.Scope>
  readonly get: <N extends Name>(
    name: N,
    runtime: string | undefined,
    activation: Activation,
  ) => ReadonlyArray<Entry<N>>
}

export class Service extends Context.Service<Service, Interface>()("vibest/PluginHooks") {}

export const layer = Layer.sync(Service, () => {
  let table: Table = {
    "session.start.before": [],
    "session.tool.execute.before": [],
    "machine.connect": [],
    "machine.remove": [],
  }

  const register: Interface["register"] = (name, entry) =>
    Effect.gen(function* () {
      const list: ReadonlyArray<Entry<typeof name>> = table[name]
      table = { ...table, [name]: [...list, entry] }

      const dispose = Effect.sync(() => {
        const current: ReadonlyArray<Entry<typeof name>> = table[name]
        table = { ...table, [name]: current.filter((e) => e !== entry) }
      })

      yield* Effect.addFinalizer(() => dispose)

      return { dispose } satisfies VibestPlugin.Registration
    })

  const get: Interface["get"] = (name, runtime, activation) =>
    table[name].filter(
      (e) => e.activation === activation && (runtime === undefined || e.runtime === undefined || e.runtime === runtime),
    )

  return Service.of({ register, get })
})

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export const run = Effect.fnUntraced(function* <N extends Name>(
  name: N,
  entry: Entry<N>,
  event: Events[N],
  scope: Scope.Scope,
  timeout: Duration.Input,
) {
  const started = yield* Clock.currentTimeMillis

  const exit = yield* Bounded.timeoutWithoutWaiting(
    Effect.suspend(() => entry.callback(event)),
    scope,
    timeout,
  ).pipe(Effect.withSpan("vibest.plugin.hook", { attributes: { "plugin.id": entry.plugin, hook: name } }))

  const ms = (yield* Clock.currentTimeMillis) - started
  const stats = entry.stats
  stats.calls++

  if (Option.isNone(exit)) {
    const error = `plugin ${entry.plugin} timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`
    stats.timedOut++
    stats.lastError = error

    return { ms, outcome: "timeout", error } satisfies Outcome<N>
  }

  if (Exit.isSuccess(exit.value)) return { ms, outcome: "ok", value: decision(exit.value.value) } satisfies Outcome<N>
  const cause = exit.value.cause
  const refusalTag = REFUSAL_TAG[name]
  const failure: unknown = Option.getOrUndefined(Cause.findErrorOption(cause))

  if (refusalTag !== undefined && isRefusal(refusalTag)(failure)) {
    stats.refused++

    return { ms, outcome: "refused", reason: failure.reason } satisfies Outcome<N>
  }

  const error = errorMessage(cause)
  stats.crashed++
  stats.lastError = error

  return { ms, outcome: "crashed", error, cause } satisfies Outcome<N>
})

export type Stopped = { readonly plugin: string; readonly reason: string }

type SessionName = "session.start.before"

export const dispatch = Effect.fnUntraced(function* <N extends SessionName>(
  name: N,
  hooks: ReadonlyArray<Entry<N>>,
  event: Events[N],
  commit: (draft: Events[N], plugin: string) => ReadonlyArray<typeof Change.Type>,
  trace: Array<TraceEntry>,
  scope: Scope.Scope,
  timeout: Duration.Input,
) {
  for (const hook of hooks) {
    const draft: Events[N] = structuredClone(event)
    const ran = yield* run(name, hook, draft, scope, timeout)
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
      yield* Effect.logWarning(`plugin ${hook.plugin} ${name} crashed`, ran.cause)

      return { plugin: hook.plugin, reason: `plugin ${hook.plugin} crashed: ${ran.error}` } satisfies Stopped
    }

    const changes = commit(draft, hook.plugin)

    if (changes.length > 0) hook.stats.changed++
    trace.push({ ...entry, outcome: "ok", changes })

    const summary =
      changes.map((c) => `${c.field} ${JSON.stringify(c.from) ?? "-"} → ${JSON.stringify(c.to) ?? "-"}`).join(", ") ||
      "no change"

    yield* Effect.log(`plugin ${hook.plugin} ${name}: ${summary} (${ran.ms} ms)`)
  }

  return undefined
})
