import type * as VibestPlugin from "@vibest/plugin/effect"
import { Catalog, type Fact, type FactOf, type FactType } from "@vibest/schema/event"
import { Effect, Stream } from "effect"

import { Agents } from "../agents.ts"
import { Bus, type BusEvent } from "../bus.ts"
import { Harnesses } from "../harness.ts"
import { Runtimes } from "../runtimes.ts"
import { Subscriptions } from "../subscriptions/service.ts"
import * as Hooks from "./hooks.ts"

type Short = keyof VibestPlugin.AgentHooks
type AgentHook = `agent.${Short}`
const HOOKS: ReadonlyArray<Short> = ["start.before", "fail"]

const isFact = (event: BusEvent): event is Fact => Object.hasOwn(Catalog, event.type)

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
    )
  }

export interface Input {
  readonly plugin: string
  readonly options: Readonly<Record<string, unknown>>
  readonly stats: Hooks.Stats
}

export const make = (hooks: Hooks.Hooks) =>
  Effect.gen(function* () {
    const subscriptions = yield* Subscriptions
    const runtimes = yield* Runtimes
    const harnesses = yield* Harnesses
    const agents = yield* Agents
    const bus = yield* Bus
    return ({ plugin, options, stats }: Input): VibestPlugin.Context => {
      const register = <N extends Hooks.Name>(
        name: N,
        callback: Hooks.Entry<N>["callback"],
        runtime: string | undefined = undefined,
      ) => hooks.register(name, { plugin, stats, runtime, callback })
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
