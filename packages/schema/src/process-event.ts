import { Schema } from "effect"

import { Event, PositiveInt, ProcessEndReason, Sender } from "./event.ts"
import { Routing } from "./plugin.ts"
import { TerminalTarget } from "./terminal.ts"

export * as ProcessEvent from "./process-event.ts"

const Text = Schema.NonEmptyString
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Base = { sessionId: Text, processId: PositiveInt }
const options = { durable: { aggregate: "sessionId", version: 1 } } as const

export const Started = Event.durable({
  type: "process.started",
  ...options,
  schema: {
    ...Base,
    harness: Text,
    provider: optional(Text),
    model: optional(Text),
    routing: optional(Routing),
    resume: optional(Text),
    runtime: Text,
    terminal: optional(TerminalTarget),
    pid: optional(PositiveInt),
  },
})

export type Started = Event.Payload<typeof Started>

export const Updated = Event.durable({
  type: "process.updated",
  ...options,
  schema: {
    ...Base,
    terminal: optional(TerminalTarget),
    pid: optional(PositiveInt),
    conversation: optional(Text),
  },
})

export type Updated = Event.Payload<typeof Updated>

export const Ready = Event.durable({
  type: "process.ready",
  ...options,
  schema: {
    ...Base,
    pid: optional(PositiveInt),
    integration: optional(Schema.Struct({ version: Text, protocol: Schema.Int })),
  },
})

export type Ready = Event.Payload<typeof Ready>

export const Ended = Event.durable({
  type: "process.ended",
  ...options,
  schema: {
    ...Base,
    reason: ProcessEndReason,
    by: optional(Sender),
  },
})

export type Ended = Event.Payload<typeof Ended>

export const Internal = Event.inventory(Started, Updated, Ready, Ended)
