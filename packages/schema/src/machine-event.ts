import { Schema } from "effect"

import { AgentFrom, Event, PositiveInt } from "./event.ts"

export * as MachineEvent from "./machine-event.ts"

const Text = Schema.NonEmptyString
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const machineOptions = { durable: { aggregate: "name", version: 1 } } as const
const remoteOptions = { durable: { aggregate: "remoteId", version: 1 } } as const

export const Added = Event.durable({
  type: "machine.added",
  ...machineOptions,
  schema: {
    name: Text,
    target: Text,
    remote: Text,
  },
})

export type Added = Event.Payload<typeof Added>

export const Removed = Event.durable({
  type: "machine.removed",
  ...machineOptions,
  schema: {
    name: Text,
  },
})

export type Removed = Event.Payload<typeof Removed>

export const Connected = Event.durable({
  type: "machine.connected",
  ...machineOptions,
  schema: {
    name: Text,
  },
})

export type Connected = Event.Payload<typeof Connected>

export const RemoteSeen = Event.durable({
  type: "remote.seen",
  ...remoteOptions,
  schema: {
    remoteId: Text,
    name: Text,
  },
})

export type RemoteSeen = Event.Payload<typeof RemoteSeen>

export const OutboxQueued = Event.durable({
  type: "remote.outbox.queued",
  ...remoteOptions,
  schema: {
    remoteId: Text,
    id: Text,
    session: Text,
    recipient: optional(Text),
    kind: optional(Schema.Literals(["send", "notice"])),
    content: Schema.String,
    from: optional(AgentFrom),
    execution: optional(PositiveInt),
  },
})

export type OutboxQueued = Event.Payload<typeof OutboxQueued>

export const OutboxAcked = Event.durable({
  type: "remote.outbox.acked",
  ...remoteOptions,
  schema: {
    remoteId: Text,
    ids: Schema.NonEmptyArray(Text),
  },
})

export type OutboxAcked = Event.Payload<typeof OutboxAcked>

export const Public = Event.inventory(Added, Removed)

export const Internal = Event.inventory(Connected, RemoteSeen, OutboxQueued, OutboxAcked)
