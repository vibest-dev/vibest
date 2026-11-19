import * as VibestPlugin from "@vibest/plugin/effect"
import { Catalog, type FactOf, type FactType } from "@vibest/schema/event"
import { Effect, Predicate, type Scope, Stream } from "effect"

import { Agents } from "../agents.ts"
import { Bus } from "../bus.ts"
import { archived, type SessionRow } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { Harnesses } from "../harnesses.ts"
import { Runtimes } from "../runtimes.ts"
import { Subscriptions } from "../subscriptions/service.ts"
import { Hooks } from "./hooks.ts"

type Short = keyof VibestPlugin.AgentHooks

const HOOKS: ReadonlyArray<Short> = ["start.before", "fail"]

type AgentRegistrations = {
  readonly [S in Short]: (
    callback: (event: VibestPlugin.AgentHooks[S]) => Effect.Effect<void, VibestPlugin.AgentFailures[S]>,
  ) => Effect.Effect<VibestPlugin.Registration, never, Scope.Scope>
}

const factsFor =
  (bus: Bus.Interface, plugin: string): VibestPlugin.EventDomain["subscribe"] =>
  <T extends FactType>(input?: { readonly types?: ReadonlyArray<T> }) => {
    const asked: ReadonlyArray<T> = input?.types ?? []
    const known = new Set(asked.filter((type) => Object.hasOwn(Catalog, type)))
    const unknown = asked.filter((type) => !known.has(type))

    const warned =
      unknown.length === 0
        ? Effect.void
        : Effect.logWarning(`plugin ${plugin} event.subscribe: ignoring unknown fact types ${unknown.join(", ")}`)

    if (asked.length > 0 && known.size === 0) return Stream.unwrap(Effect.as(warned, Stream.never))

    const definitions: ReadonlyArray<{ readonly type: FactType }> =
      known.size === 0 ? Object.values(Catalog) : [...known].map((type) => ({ type }))

    const wanted: ReadonlySet<string> = new Set(definitions.map((definition) => definition.type))
    const isWanted = (event: Bus.BusEvent): event is FactOf<T> => wanted.has(event.type)

    return Stream.unwrap(
      Effect.andThen(
        warned,
        Effect.map(bus.subscribe(definitions), (subscription) =>
          Stream.fromSubscription(subscription).pipe(Stream.filter(isWanted)),
        ),
      ),
    )
  }

const sessionsFor = (db: Db.Interface, plugin: string): VibestPlugin.SessionDomain => {
  const pluginSession = (row: SessionRow) =>
    Effect.gen(function* () {
      const last = row.lastExecution

      const latest =
        last === null || last.endedAt === null
          ? null
          : {
              execution: last.id,
              outcome: last.outcome,
              sent: yield* db.inbox.sentDuring(row.id, last.startedAt, last.endedAt),
              endedAt: last.endedAt,
            }

      return { id: row.id, title: row.name, parentId: row.parentId, status: row.status, latest }
    })

  const refuse = (message: string) => Effect.fail(new VibestPlugin.SessionSendFailed({ message }))

  const send = (input: VibestPlugin.SessionSend) =>
    Effect.gen(function* () {
      if (input.request !== undefined && (yield* db.inbox.pluginQueued(plugin, input.request))) return
      const target = yield* db.session.sessionIdentity(input.to)

      if (target === undefined) return yield* refuse(`no session ${input.to}`)
      const session = yield* db.session.getSession(input.to)

      const recipient =
        target.entry || (session !== undefined && !archived(session))
          ? { local: input.to }
          : yield* db.session.nearestAlive(input.to)

      if (recipient === undefined) return yield* refuse(`${input.to} has ended and no session above it is running`)

      if ("peer" in recipient)
        return yield* refuse(
          `${input.to} has ended and the session above it is on another machine; a plugin sends only to sessions on this machine`,
        )

      if ((yield* db.inbox.insertSend(recipient.local, input.message, { plugin }, input.request)) === undefined)
        return yield* refuse(`${recipient.local} is not running`)
    })

  return {
    list: () => db.session.listSessions().pipe(Effect.flatMap(Effect.forEach(pluginSession))),
    get: (id) =>
      db.session
        .getSession(id)
        .pipe(Effect.flatMap((row) => (row === undefined ? Effect.succeed(undefined) : pluginSession(row)))),
    send,
  }
}

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
  const db = yield* Db.Service

  return ({ plugin, activation, options, stats }: Input): VibestPlugin.Context => {
    const register = <N extends Hooks.Name>(
      name: N,
      callback: Hooks.Entry<N>["callback"],
      runtime: string | undefined = undefined,
    ) => hooks.register(name, { plugin, activation, stats, runtime, callback })

    const agentRegistrations: AgentRegistrations = {
      "start.before": (callback) => register("agent.start.before", callback),
      fail: (callback) => register("agent.fail", callback),
    }

    const hook: VibestPlugin.AgentDomain["hook"] = (short, callback) => {
      if (!Predicate.isString(short) || !HOOKS.includes(short)) {
        return Effect.die(
          new Error(
            `unsupported hook ${JSON.stringify(`agent.${String(short)}`)}; supported: ${HOOKS.map((s) => `agent.${s}`).join(", ")}`,
          ),
        )
      }

      return agentRegistrations[short](callback)
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
      session: sessionsFor(db, plugin),
    }
  }
})
