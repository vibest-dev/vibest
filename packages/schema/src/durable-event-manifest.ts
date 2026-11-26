import { Effect, Schema } from "effect"

import { AutomationEvent } from "./automation-event.ts"
import { Event, InvalidDurableEvent } from "./event.ts"
import { MachineEvent } from "./machine-event.ts"
import { ProcessEvent } from "./process-event.ts"
import { ProjectEvent } from "./project-event.ts"
import { SessionEvent } from "./session-event.ts"

export * as DurableEventManifest from "./durable-event-manifest.ts"

export const PublicEvents = Event.inventory(
  ...ProjectEvent.Public,
  ...SessionEvent.Public,
  ...MachineEvent.Public,
  ...AutomationEvent.Public,
)

export const AllDurableDefinitions = Event.inventory(
  ...PublicEvents,
  ...SessionEvent.Internal,
  ...ProcessEvent.Internal,
  ...MachineEvent.Internal,
  ...AutomationEvent.Internal,
)

export const DurableEvents = Event.durableMap(AllDurableDefinitions)

export type PublicDurableDefinition = (typeof PublicEvents)[number]

export type PublicEventType = PublicDurableDefinition["type"]

export type PublicDurableEvent = {
  readonly [D in PublicDurableDefinition as D["type"]]: Event.Payload<D>
}[PublicEventType]

export type PublicEventOf<T extends PublicEventType> = Extract<PublicDurableEvent, { readonly type: T }>

export type AnyDurableDefinition = (typeof AllDurableDefinitions)[number]

export type DurableEventType = AnyDurableDefinition["type"]

export type DurableEvent = {
  readonly [D in AnyDurableDefinition as D["type"]]: Event.Payload<D>
}[DurableEventType]

export type DurableEventOf<T extends DurableEventType> = Extract<DurableEvent, { readonly type: T }>

export const PublicEventTypes: ReadonlySet<string> = new Set(PublicEvents.map((definition) => definition.type))

export const isPublicEventType = (type: string): type is PublicEventType => PublicEventTypes.has(type)

export const isDurableEventOf = <T extends DurableEventType>(
  type: T,
  event: DurableEvent,
): event is DurableEventOf<T> => event.type === type

export interface StoredRow {
  readonly id: string
  readonly aggregateId: string
  readonly seq: number
  readonly created: number
  readonly type: string
  readonly data: string
}

const strict = { onExcessProperty: "error" } as const

export const encodeJson = <T>(definition: AnyDurableDefinition, data: T): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeUnknownEffect(definition.data)(data, strict).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const encodeData = <T>(definition: AnyDurableDefinition, data: T): Effect.Effect<string, Schema.SchemaError> =>
  encodeJson(definition, data).pipe(
    Effect.tap((json) => Schema.decodeUnknownEffect(definition.data)(JSON.parse(json), strict)),
  )

export const decodeRow = (row: StoredRow): Effect.Effect<DurableEvent, InvalidDurableEvent> => {
  const where = `event ${row.aggregateId} ${row.seq}`

  const refuse = (message: string) =>
    new InvalidDurableEvent({
      aggregateId: row.aggregateId,
      seq: row.seq,
      type: row.type,
      message: `${where}: ${message}`,
    })

  const definition = DurableEvents.get(row.type)

  if (definition === undefined) return Effect.fail(refuse(`${row.type} is not in the durable event manifest`))

  return Effect.try({
    try: () => JSON.parse(row.data),
    catch: (cause) => refuse(`${row.type} data is not JSON: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(definition)(
        {
          id: row.id,
          type: definition.type,
          created: row.created,
          durable: {
            aggregateId: row.aggregateId,
            seq: row.seq,
            version: definition.durable.version,
          },
          data: json,
        },
        strict,
      ).pipe(Effect.mapError((cause) => refuse(`${row.type} does not decode: ${cause.message}`))),
    ),
  )
}
