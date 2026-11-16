import type { Fact, FactOf, FactType } from "@vibest/schema/event"
import type { Stream } from "effect"

export type { Fact, FactOf, FactType }

export interface EventDomain {
  readonly subscribe: <T extends FactType = FactType>(input?: {
    readonly types?: ReadonlyArray<T>
  }) => Stream.Stream<FactOf<T>>
}
