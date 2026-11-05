import type { Runtime } from "@vibest/plugin"
import { Context, Duration, Effect, Layer, Option, PubSub, type Scope } from "effect"

/** One row of the `event` table, as committed. */
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

/** Observations the schema keeps out of the table: published, never stored. */
export type LiveEvent =
  | {
      readonly type: "live.state"
      readonly runtime: string
      readonly terminal: Runtime.Terminal
      readonly state: Runtime.AgentState
    }
  | { readonly type: "live.exited"; readonly runtime: string; readonly terminal: Runtime.Terminal }
  | { readonly type: "live.reset"; readonly runtime: string; readonly machine: string }
  | { readonly type: "live.turn_start"; readonly sessionId: string; readonly at: number }
  | { readonly type: "live.drain" }

export type EngineEvent = StoredEvent | LiveEvent

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<EngineEvent>()
  return {
    observe: (event: LiveEvent) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
    /** Every event from now on. Subscribe before the action whose consequence you wait for. */
    subscribe: PubSub.subscribe(pubsub),
    /** For the Db only: publish a committed transaction's rows, in id order. Enqueues; runs no handler. */
    published: (events: ReadonlyArray<StoredEvent>) =>
      events.length === 0 ? Effect.void : PubSub.publishAll(pubsub, events).pipe(Effect.asVoid),
  }
})

export class Bus extends Context.Service<Bus, Effect.Success<typeof make>>()("vibest/Bus") {
  static readonly layer = Layer.effect(Bus, make)
}

const takeMatch = <A, E, R>(
  subscription: PubSub.Subscription<EngineEvent>,
  match: (event: EngineEvent) => Effect.Effect<Option.Option<A>, E, R>,
) =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* PubSub.take(subscription)
      const found = yield* match(event)
      if (Option.isSome(found)) return found.value
    }
  })

/**
 * A wait inside one operation on something the Bus carries. Subscribes before `look`, so an event between the two is
 * not lost. At the deadline, runs `onDeadline` once.
 */
export const awaitEvent = <A, E, R>(
  look: Effect.Effect<Option.Option<A>, E, R>,
  match: (event: EngineEvent) => Effect.Effect<Option.Option<A>, E, R>,
  deadline: Duration.Duration,
  onDeadline: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Bus> =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* (yield* Bus).subscribe
      const found = yield* look
      if (Option.isSome(found)) return found.value
      return yield* takeMatch(subscription, match).pipe(
        Effect.timeoutOrElse({ duration: deadline, orElse: () => onDeadline }),
      )
    }),
  )

void (null as unknown as Scope.Scope)
