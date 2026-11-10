import type { Runtime } from "@vibest/plugin"
import { Context, type Duration, Effect, Layer, Option, PubSub, type Scope } from "effect"

import { LayerNode } from "./effect/layer-node.ts"

export interface StoredEvent<T extends StoredType = StoredType> {
  readonly id: number
  readonly at: number
  readonly sessionId: string
  readonly type: T
  readonly processId?: number
  readonly turnId?: number
  readonly inboxId?: number
  readonly data: Readonly<Record<string, unknown>>
}

export type StoredType =
  | "process.start"
  | "process.ready"
  | "process.conversation"
  | "process.end"
  | "turn.start"
  | "turn.end"
  | "turn.reported"
  | "inbox.queued"
  | "inbox.status"
  | "peer.start"

export type LiveEvent =
  | {
      readonly type: "live.state"
      readonly runtime: string
      readonly terminal: Runtime.Terminal
      readonly state: Runtime.AgentState
    }
  | { readonly type: "live.exited"; readonly runtime: string; readonly terminal: Runtime.Terminal }
  | { readonly type: "live.seen"; readonly runtime: string; readonly terminal: Runtime.Terminal }
  | { readonly type: "live.reset"; readonly runtime: string; readonly machine: string }
  | { readonly type: "live.turn_start"; readonly sessionId: string; readonly at: number }
  | { readonly type: "live.drain" }
  | { readonly type: "live.session"; readonly sessionId: string }
  | { readonly type: "live.project"; readonly projectId: string }
  | { readonly type: "live.outbox"; readonly peerId: string }

export type EngineEvent = StoredEvent | LiveEvent

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<EngineEvent>()
  return {
    observe: (event: LiveEvent) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
    subscribe: PubSub.subscribe(pubsub),
    published: (events: ReadonlyArray<EngineEvent>) =>
      events.length === 0 ? Effect.void : PubSub.publishAll(pubsub, events).pipe(Effect.asVoid),
  }
})

export class Bus extends Context.Service<Bus, Effect.Success<typeof make>>()("vibest/Bus") {
  static readonly layer = Layer.effect(Bus, make)

  static readonly node = LayerNode.make({ service: Bus, layer: Bus.layer, deps: [] })
}

export const awaitOn = <A, E, R>(
  subscription: PubSub.Subscription<EngineEvent>,
  look: Effect.Effect<Option.Option<A>, E, R>,
  match: (event: EngineEvent) => Effect.Effect<Option.Option<A>, E, R>,
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
  match: (event: EngineEvent) => Effect.Effect<Option.Option<A>, E, R>,
  deadline: Duration.Duration,
  onDeadline: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | Bus> =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* (yield* Bus).subscribe
      return yield* awaitOn(subscription, look, match, deadline, onDeadline)
    }),
  )
