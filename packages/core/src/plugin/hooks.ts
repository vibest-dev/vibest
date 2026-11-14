import type * as VibestPlugin from "@vibest/plugin/effect"
import { messageOf } from "@vibest/schema/error"
import { Cause, Clock, Duration, Effect, Exit, Option, type Scope } from "effect"

import { timeoutWithoutWaiting } from "../effect/bounded.ts"

export interface Events {
  readonly "agent.start.before": VibestPlugin.AgentStartBefore
  readonly "agent.fail": VibestPlugin.AgentFail
  readonly "machine.connect": VibestPlugin.MachineEvent
  readonly "machine.remove": VibestPlugin.MachineEvent
}

export interface Results extends Record<keyof Events, unknown> {
  readonly "agent.start.before": void
  readonly "agent.fail": void
  readonly "machine.connect": ReadonlyArray<VibestPlugin.MachineNote>
  readonly "machine.remove": ReadonlyArray<VibestPlugin.MachineNote>
}

interface Failures extends Record<keyof Events, unknown> {
  readonly "agent.start.before": VibestPlugin.AgentRefused
  readonly "agent.fail": never
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

export type Entry<N extends Name> = {
  readonly plugin: string
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

const isAgentRefused = (e: unknown): e is VibestPlugin.AgentRefused =>
  (e as { _tag?: unknown } | undefined)?._tag === "AgentRefused"

const decision = <A>(value: A | void) => (typeof value === "object" && value !== null ? value : undefined)

export const make = () => {
  let table: Table = { "agent.start.before": [], "agent.fail": [], "machine.connect": [], "machine.remove": [] }
  const register = <N extends Name>(name: N, entry: Entry<N>) =>
    Effect.gen(function* () {
      const list: ReadonlyArray<Entry<N>> = table[name]
      table = { ...table, [name]: [...list, entry] }
      const dispose = Effect.sync(() => {
        const current: ReadonlyArray<Entry<N>> = table[name]
        table = { ...table, [name]: current.filter((e) => e !== entry) }
      })
      yield* Effect.addFinalizer(() => dispose)
      return { dispose } satisfies VibestPlugin.Registration
    })
  const get = <N extends Name>(name: N, runtime?: string): ReadonlyArray<Entry<N>> =>
    table[name].filter((e) => runtime === undefined || e.runtime === undefined || e.runtime === runtime)
  return { register, get }
}

export type Hooks = ReturnType<typeof make>

export const run = Effect.fnUntraced(function* <N extends Name>(
  name: N,
  entry: Entry<N>,
  event: Events[N],
  scope: Scope.Scope,
  timeout: Duration.Input,
) {
  const started = yield* Clock.currentTimeMillis
  const exit = yield* timeoutWithoutWaiting(
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
  const refused = Option.filter(Cause.findErrorOption(cause), isAgentRefused)
  if (name === "agent.start.before" && Option.isSome(refused)) {
    stats.refused++
    return { ms, outcome: "refused", reason: refused.value.reason } satisfies Outcome<N>
  }
  const error = errorMessage(cause)
  stats.crashed++
  stats.lastError = error
  return { ms, outcome: "crashed", error, cause } satisfies Outcome<N>
})
