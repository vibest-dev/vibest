import * as VibestPlugin from "@vibest/plugin/effect"
import {
  isPublicEventType,
  type PublicDurableEvent,
  type PublicEventOf,
  PublicEvents,
  type PublicEventType,
} from "@vibest/schema/durable-event-manifest"
import { Effect, Predicate, type Scope, Stream } from "effect"

import { Agents } from "../agents.ts"
import { Bus } from "../bus.ts"
import { Harnesses } from "../harnesses.ts"
import { Runtimes } from "../runtimes.ts"
import { Archive } from "../session/archive.ts"
import { Sends } from "../session/sends.ts"
import { Summaries } from "../session/summaries.ts"
import { Subscriptions } from "../subscriptions/service.ts"
import { Hooks } from "./hooks.ts"

type Short = keyof VibestPlugin.SessionHooks

type SessionRegistrations = {
  readonly [S in Short]: (
    callback: (event: VibestPlugin.SessionHooks[S]) => Effect.Effect<void, VibestPlugin.SessionFailures[S]>,
  ) => Effect.Effect<VibestPlugin.Registration, never, Scope.Scope>
}

export const factsFor = (bus: Bus.Interface, plugin: string): VibestPlugin.EventDomain["subscribe"] => {
  function subscribe<T extends PublicEventType = PublicEventType>(input?: {
    readonly types?: ReadonlyArray<T>
  }): Stream.Stream<PublicEventOf<T>>
  function subscribe(input?: { readonly types?: ReadonlyArray<PublicEventType> }): Stream.Stream<PublicDurableEvent> {
    const asked = input?.types ?? []
    const known = new Set(asked.filter((type) => isPublicEventType(type)))
    const unknown = asked.filter((type) => !known.has(type))

    const warned =
      unknown.length === 0
        ? Effect.void
        : Effect.logWarning(`plugin ${plugin} event.subscribe: ignoring unknown event types ${unknown.join(", ")}`)

    if (asked.length > 0 && known.size === 0) return Stream.unwrap(Effect.as(warned, Stream.never))

    if (known.size > 0)
      return Stream.unwrap(
        Effect.andThen(
          warned,
          Effect.map(bus.subscribe([...known].map((type) => ({ type }))), Stream.fromSubscription),
        ),
      )

    return Stream.unwrap(Effect.map(bus.subscribe(PublicEvents), Stream.fromSubscription))
  }

  return subscribe
}

const sessionsFor = (
  summaries: Summaries.Interface,
  sends: Sends.Interface,
  archive: Archive.Interface,
  hook: VibestPlugin.SessionDomain["hook"],
  plugin: string,
): VibestPlugin.SessionDomain => ({
  hook,
  list: summaries.list,
  get: summaries.get,
  sentIn: summaries.sentIn,
  send: (input) =>
    sends.relay(input.to, input.message, { type: "plugin", plugin }, input.request).pipe(
      Effect.asVoid,
      Effect.mapError((e) => new VibestPlugin.SessionSendFailed({ message: e.message })),
    ),
  stop: (id, options) =>
    archive.stop(id, { type: "plugin", plugin }, options?.idleSince).pipe(
      Effect.map((out) => out.stopped),
      Effect.mapError((e) => new VibestPlugin.SessionStopFailed({ message: e.message })),
    ),
})

export interface Input {
  readonly plugin: string
  readonly activation: Hooks.Activation
  readonly options: VibestPlugin.PluginOptions
  readonly stats: Hooks.Stats
}

export const make = Effect.gen(function* () {
  const hooks = yield* Hooks.Service
  const subscriptions = yield* Subscriptions.Service
  const runtimes = yield* Runtimes.Service
  const harnesses = yield* Harnesses.Service
  const agents = yield* Agents.Service
  const bus = yield* Bus.Service
  const summaries = yield* Summaries.Service
  const sends = yield* Sends.Service
  const archive = yield* Archive.Service

  return ({ plugin, activation, options, stats }: Input): VibestPlugin.Context => {
    const register = <N extends Hooks.Name>(
      name: N,
      callback: Hooks.Entry<N>["callback"],
      runtime: string | undefined = undefined,
    ) => hooks.register(name, { plugin, activation, stats, runtime, callback })

    const sessionRegistrations: SessionRegistrations = {
      "start.before": (callback) => register("session.start.before", callback),
      "tool.execute.before": (callback) => register("session.tool.execute.before", callback),
    }

    const hook: VibestPlugin.SessionDomain["hook"] = (short, callback) => {
      if (!Predicate.isString(short) || !Object.hasOwn(sessionRegistrations, short)) {
        return Effect.die(
          new Error(
            `unsupported hook ${JSON.stringify(`session.${String(short)}`)}; supported: ${Object.keys(
              sessionRegistrations,
            )
              .map((s) => `session.${s}`)
              .join(", ")}`,
          ),
        )
      }

      return sessionRegistrations[short](callback)
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
      agent: { transform: agents.transformFor(plugin) },
      machine: { hook: machine },
      runtime: { transform: runtimes.transform },
      harness: { transform: harnesses.transform },
      subscription: { report: (input) => subscriptions.report(input) },
      event: { subscribe: factsFor(bus, plugin) },
      session: sessionsFor(summaries, sends, archive, hook, plugin),
    }
  }
})
