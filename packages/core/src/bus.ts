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

type EventOf<T extends BusEvent["type"]> = Extract<BusEvent, { readonly type: T }>

export interface Subscribe {
  (): Effect.Effect<PubSub.Subscription<BusEvent>, never, Scope.Scope>
  <T extends BusEvent["type"]>(
    definitions: ReadonlyArray<{ readonly type: T }>,
  ): Effect.Effect<PubSub.Subscription<EventOf<T>>, never, Scope.Scope>
}

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<BusEvent>()
  const typed = new Map<string, Set<PubSub.PubSub<BusEvent>>>()

  const deliver = (event: BusEvent) =>
    Effect.forEach(typed.get(event.type) ?? [], (subscriber) => PubSub.publish(subscriber, event), { discard: true })

  const subscribeTyped = (definitions: ReadonlyArray<{ readonly type: string }>) => {
    const types = new Set(definitions.map((definition) => definition.type))
    return Effect.acquireRelease(
      PubSub.unbounded<BusEvent>().pipe(
        Effect.tap((subscriber) =>
          Effect.sync(() => {
            for (const type of types) typed.set(type, (typed.get(type) ?? new Set()).add(subscriber))
          }),
        ),
      ),
      (subscriber) =>
        Effect.sync(() => {
          for (const type of types) {
            const subscribers = typed.get(type)
            subscribers?.delete(subscriber)
            if (subscribers?.size === 0) typed.delete(type)
          }
        }).pipe(Effect.andThen(PubSub.shutdown(subscriber))),
    ).pipe(Effect.flatMap(PubSub.subscribe))
  }

  const subscribe = ((definitions?: ReadonlyArray<{ readonly type: string }>) =>
    definitions === undefined ? PubSub.subscribe(pubsub) : subscribeTyped(definitions)) as Subscribe

  return {
    observe: (event: Signal) => PubSub.publish(pubsub, event).pipe(Effect.andThen(deliver(event))),
    subscribe,
    published: (events: ReadonlyArray<BusEvent>) =>
      events.length === 0
        ? Effect.void
        : PubSub.publishAll(pubsub, events).pipe(Effect.andThen(Effect.forEach(events, deliver, { discard: true }))),
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
      const subscription = yield* (yield* Bus).subscribe()
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
