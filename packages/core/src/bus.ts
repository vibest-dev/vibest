import type { Runtime } from "@vibest/plugin/effect"
import type { Fact } from "@vibest/schema/event"
import type { RuntimeAddress } from "@vibest/schema/session"
import { Context, type Duration, Effect, Layer, Option, PubSub, type Scope } from "effect"

import { LayerNode } from "./effect/layer-node.ts"

export type Signal =
  | {
      readonly type: "terminal.state"
      readonly runtime: string
      readonly terminal: RuntimeAddress
      readonly state: Runtime.AgentState
    }
  | { readonly type: "terminal.exited"; readonly runtime: string; readonly terminal: RuntimeAddress }
  | { readonly type: "terminal.seen"; readonly runtime: string; readonly terminal: RuntimeAddress }
  | { readonly type: "runtime.reset"; readonly runtime: string; readonly machine: string }
  | { readonly type: "drain.released" }
  | { readonly type: "session.changed"; readonly sessionId: string }
  | { readonly type: "project.changed"; readonly projectId: string }

export type BusEvent = Fact | Signal

export const TerminalState = { type: "terminal.state" } as const
export const TerminalExited = { type: "terminal.exited" } as const
export const RuntimeReset = { type: "runtime.reset" } as const

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<BusEvent>()
  return {
    observe: (event: Signal) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
    subscribe: PubSub.subscribe(pubsub),
    published: (events: ReadonlyArray<BusEvent>) =>
      events.length === 0 ? Effect.void : PubSub.publishAll(pubsub, events).pipe(Effect.asVoid),
  }
})

export class Bus extends Context.Service<Bus, Effect.Success<typeof make>>()("vibest/Bus") {
  static readonly layer = Layer.effect(Bus, make)

  static readonly node = LayerNode.make({ service: Bus, layer: Bus.layer, deps: [] })
}

export const awaitOn = <A, E, R>(
  subscription: PubSub.Subscription<BusEvent>,
  look: Effect.Effect<Option.Option<A>, E, R>,
  match: (event: BusEvent) => Effect.Effect<Option.Option<A>, E, R>,
  deadline: Duration.Duration,
  onDeadline: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const next: Effect.Effect<A, E, R> = PubSub.take(subscription).pipe(
    Effect.flatMap(match),
    Effect.flatMap((found) => (Option.isSome(found) ? Effect.succeed(found.value) : next)),
  )
  return look.pipe(
    Effect.flatMap((found) => (Option.isSome(found) ? Effect.succeed(found.value) : next)),
    Effect.timeoutOrElse({ duration: deadline, orElse: () => onDeadline }),
  )
}

export const awaitEvent = <A, E, R>(
  look: Effect.Effect<Option.Option<A>, E, R>,
  match: (event: BusEvent) => Effect.Effect<Option.Option<A>, E, R>,
  deadline: Duration.Duration,
  onDeadline: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | Bus> =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* (yield* Bus).subscribe
      return yield* awaitOn(subscription, look, match, deadline, onDeadline)
    }),
  )

export const withChanges = (events: ReadonlyArray<BusEvent>): ReadonlyArray<BusEvent> => {
  const sessions = new Set<string>()
  const projects = new Set<string>()
  for (const event of events) {
    if (event.type === "session.changed") sessions.add(event.sessionId)
    else if (event.type === "project.changed") projects.add(event.projectId)
  }
  const changes: Array<BusEvent> = []
  for (const event of events) {
    if (!("seq" in event)) continue
    if (event.sessionId !== undefined && !sessions.has(event.sessionId)) {
      sessions.add(event.sessionId)
      changes.push({ type: "session.changed", sessionId: event.sessionId })
    }
    if (event.projectId !== undefined && !projects.has(event.projectId)) {
      projects.add(event.projectId)
      changes.push({ type: "project.changed", projectId: event.projectId })
    }
  }
  return [...events, ...changes]
}
