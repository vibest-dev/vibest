import { Schema } from "effect"

import { Event, ExecutionFailure, ExecutionObservation, PositiveInt, Sender } from "./event.ts"

export * as SessionEvent from "./session-event.ts"

const Text = Schema.NonEmptyString
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Base = { sessionId: Text }
const options = { durable: { aggregate: "sessionId", version: 1 } } as const

export const Created = Event.durable({
  type: "session.created",
  ...options,
  schema: {
    ...Base,
    project: Text,
    agent: Text,
    name: Text,
    directory: Schema.String,
    parent: optional(Text),
    origin: optional(Schema.Struct({ remote: Text, project: Text, session: optional(Text) })),
    messageId: optional(PositiveInt),
  },
})

export type Created = Event.Payload<typeof Created>

export const Renamed = Event.durable({
  type: "session.renamed",
  ...options,
  schema: {
    ...Base,
    name: Text,
  },
})

export type Renamed = Event.Payload<typeof Renamed>

export const DirectoryChanged = Event.durable({
  type: "session.directory_changed",
  ...options,
  schema: {
    ...Base,
    directory: Text,
  },
})

export type DirectoryChanged = Event.Payload<typeof DirectoryChanged>

export const Archived = Event.durable({
  type: "session.archived",
  ...options,
  schema: Base,
})

export type Archived = Event.Payload<typeof Archived>

export const Linked = Event.durable({
  type: "session.linked",
  ...options,
  schema: {
    ...Base,
    to: Text,
    remote: optional(Text),
  },
})

export type Linked = Event.Payload<typeof Linked>

export const Unlinked = Event.durable({
  type: "session.unlinked",
  ...options,
  schema: {
    ...Base,
    to: Text,
    remote: optional(Text),
  },
})

export type Unlinked = Event.Payload<typeof Unlinked>

export const ExecutionAllocated = Event.durable({
  type: "session.execution.allocated",
  ...options,
  schema: {
    ...Base,
    executionId: PositiveInt,
    processId: optional(PositiveInt),
    typed: optional(Text),
  },
})

export type ExecutionAllocated = Event.Payload<typeof ExecutionAllocated>

export const ExecutionStarted = Event.durable({
  type: "session.execution.started",
  ...options,
  schema: {
    ...Base,
    executionId: PositiveInt,
    processId: optional(PositiveInt),
  },
})

export type ExecutionStarted = Event.Payload<typeof ExecutionStarted>

export const ExecutionSucceeded = Event.durable({
  type: "session.execution.succeeded",
  ...options,
  schema: {
    ...Base,
    executionId: PositiveInt,
    reply: optional(Schema.String),
  },
})

export type ExecutionSucceeded = Event.Payload<typeof ExecutionSucceeded>

export const ExecutionFailed = Event.durable({
  type: "session.execution.failed",
  ...options,
  schema: {
    ...Base,
    executionId: PositiveInt,
    failure: ExecutionFailure,
    reply: optional(Schema.String),
  },
})

export type ExecutionFailed = Event.Payload<typeof ExecutionFailed>

export const ExecutionInterrupted = Event.durable({
  type: "session.execution.interrupted",
  ...options,
  schema: {
    ...Base,
    executionId: PositiveInt,
    reason: optional(Text),
    reply: optional(Schema.String),
  },
})

export type ExecutionInterrupted = Event.Payload<typeof ExecutionInterrupted>

export const ExecutionUnresolved = Event.durable({
  type: "session.execution.unresolved",
  ...options,
  schema: {
    ...Base,
    executionId: PositiveInt,
    observation: ExecutionObservation,
    failure: optional(ExecutionFailure),
    reply: optional(Schema.String),
  },
})

export type ExecutionUnresolved = Event.Payload<typeof ExecutionUnresolved>

export const ExecutionInput = Event.durable({
  type: "session.execution.input",
  ...options,
  schema: {
    ...Base,
    executionId: PositiveInt,
    typed: Text,
  },
})

export type ExecutionInput = Event.Payload<typeof ExecutionInput>

export const InboxEnqueued = Event.durable({
  type: "session.inbox.enqueued",
  ...options,
  schema: {
    ...Base,
    messageId: PositiveInt,
    sender: Sender,
    content: Schema.String,
    senderExecutionId: optional(PositiveInt),
    requestId: optional(Text),
    transferId: optional(Text),
    aboutSessionId: optional(Text),
  },
})

export type InboxEnqueued = Event.Payload<typeof InboxEnqueued>

export const InboxDelivering = Event.durable({
  type: "session.inbox.delivering",
  ...options,
  schema: {
    ...Base,
    messageId: PositiveInt,
    execution: optional(PositiveInt),
  },
})

export type InboxDelivering = Event.Payload<typeof InboxDelivering>

export const InboxDelivered = Event.durable({
  type: "session.inbox.delivered",
  ...options,
  schema: {
    ...Base,
    messageId: PositiveInt,
    recipientExecutionId: PositiveInt,
  },
})

export type InboxDelivered = Event.Payload<typeof InboxDelivered>

export const InboxFailed = Event.durable({
  type: "session.inbox.failed",
  ...options,
  schema: {
    ...Base,
    messageId: PositiveInt,
    reason: Text,
  },
})

export type InboxFailed = Event.Payload<typeof InboxFailed>

export const InboxDropped = Event.durable({
  type: "session.inbox.dropped",
  ...options,
  schema: {
    ...Base,
    messageId: PositiveInt,
    reason: Text,
  },
})

export type InboxDropped = Event.Payload<typeof InboxDropped>

export const Public = Event.inventory(
  Created,
  Renamed,
  DirectoryChanged,
  Archived,
  Linked,
  Unlinked,
  ExecutionAllocated,
  ExecutionStarted,
  ExecutionSucceeded,
  ExecutionFailed,
  ExecutionInterrupted,
  ExecutionUnresolved,
  ExecutionInput,
  InboxEnqueued,
  InboxDelivered,
  InboxFailed,
  InboxDropped,
)

export const Internal = Event.inventory(InboxDelivering)
