import type { FactOf, FactType } from "@vibest/schema/event"

export type { Fact, FactOf, FactType } from "@vibest/schema/event"

export interface EventDomain {
  readonly subscribe: <T extends FactType = FactType>(input?: {
    readonly types?: ReadonlyArray<T>
  }) => AsyncIterable<FactOf<T>>
}
