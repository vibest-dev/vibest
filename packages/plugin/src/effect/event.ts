import type {
  PublicDurableEvent as DurableEvent,
  PublicEventOf as EventOf,
  PublicEventType as EventType,
} from "@vibest/schema/durable-event-manifest"
import type { Stream } from "effect"

export type { DurableEvent, EventOf, EventType }

export interface EventDomain {
  readonly subscribe: <T extends EventType = EventType>(input?: {
    readonly types?: ReadonlyArray<T>
  }) => Stream.Stream<EventOf<T>>
}
