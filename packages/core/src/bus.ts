import type { Runtime } from "@vibest/plugin"
import { Context, Effect, Layer, PubSub } from "effect"

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
