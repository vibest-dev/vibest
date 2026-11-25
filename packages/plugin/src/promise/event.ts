import type { PublicFact as Fact, PublicFactOf as FactOf, PublicFactType as FactType } from "@vibest/schema/event"

export type { Fact, FactOf, FactType }

export interface EventDomain {
  readonly subscribe: <T extends FactType = FactType>(input?: {
    readonly types?: ReadonlyArray<T>
  }) => AsyncIterable<FactOf<T>>
}
