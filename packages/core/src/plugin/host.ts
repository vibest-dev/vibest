import type * as VibestPlugin from "@vibest/plugin/effect"
import { Catalog, type FactOf, type FactType } from "@vibest/schema/event"
import { Effect, Stream } from "effect"

import { Agents } from "../agents.ts"
import { Bus } from "../bus.ts"
import { Harnesses } from "../harnesses.ts"
import { Runtimes } from "../runtimes.ts"
import { Subscriptions } from "../subscriptions/service.ts"
import { Hooks } from "./hooks.ts"

type Short = keyof VibestPlugin.AgentHooks
type AgentHook = `agent.${Short}`
const HOOKS: ReadonlyArray<Short> = ["start.before", "fail"]

const factsFor =
  (bus: Bus.Interface, plugin: string): VibestPlugin.EventDomain["subscribe"] =>
  <T extends FactType>(input?: { readonly types?: ReadonlyArray<T> }) => {
    const asked: ReadonlyArray<string> = input?.types ?? []
    const known = new Set(asked.filter((type) => Object.hasOwn(Catalog, type)))
    const unknown = asked.filter((type) => !known.has(type))
    const warned =
      unknown.length === 0
        ? Effect.void
        : Effect.logWarning(`plugin ${plugin} event.subscribe: ignoring unknown fact types ${unknown.join(", ")}`)
    if (asked.length > 0 && known.size === 0) return Stream.unwrap(Effect.as(warned, Stream.never))
    const definitions = known.size === 0 ? Object.values(Catalog) : [...known].map((type) => Catalog[type as FactType])
    return Stream.unwrap(
      Effect.andThen(warned, Effect.map(bus.subscribe(definitions), Stream.fromSubscription)),
    ) as Stream.Stream<FactOf<T>>
  }

export interface Input {
  readonly plugin: string
  readonly activation: object
  readonly options: Readonly<Record<string, unknown>>
  readonly stats: Hooks.Stats
}

export const make = Effect.gen(function* () {
  const hooks = yield* Hooks.Service
  const subscriptions = yield* Subscriptions
  const runtimes = yield* Runtimes.Service
  const harnesses = yield* Harnesses.Service
  const agents = yield* Agents.Service
  const bus = yield* Bus.Service
  return ({ plugin, activation, options, stats }: Input): VibestPlugin.Context => {
    const register = <N extends Hooks.Name>(
      name: N,
      callback: Hooks.Entry<N>["callback"],
      runtime: string | undefined = undefined,
    ) => hooks.register(name, { plugin, activation, stats, runtime, callback })
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
    return {
      options,
      agent: { hook, transform: agents.transform },
      machine: { hook: machine },
      runtime: { transform: runtimes.transform },
      harness: { transform: harnesses.transform },
      subscription: { report: (input) => subscriptions.report(input) },
      event: { subscribe: factsFor(bus, plugin) },
    }
  }
})
