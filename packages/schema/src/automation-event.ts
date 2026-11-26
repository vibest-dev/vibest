import { Schema } from "effect"

import { Automation } from "./automation.ts"
import { Event } from "./event.ts"
import { SessionId } from "./id.ts"

export * as AutomationEvent from "./automation-event.ts"

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Base = { automationId: Automation.ID }
const options = { durable: { aggregate: "automationId", version: 1 } } as const

export const Created = Event.durable({
  type: "automation.created",
  ...options,
  schema: {
    ...Base,
    name: Schema.NonEmptyString,
    projectId: Schema.String,
    sessionId: optional(SessionId),
    directory: Schema.String,
    trigger: Automation.Trigger,
    tz: Schema.String,
    action: Automation.Action,
    expiresAt: optional(Schema.Number),
    nextDueAt: optional(Schema.Number),
  },
})

export type Created = Event.Payload<typeof Created>

export const Paused = Event.durable({
  type: "automation.paused",
  ...options,
  schema: {
    ...Base,
    reason: optional(Schema.String),
    lastOutcome: optional(Automation.Outcome),
    lastRunAt: optional(Schema.Number),
    failures: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
})

export type Paused = Event.Payload<typeof Paused>

export const Resumed = Event.durable({
  type: "automation.resumed",
  ...options,
  schema: {
    ...Base,
    nextDueAt: optional(Schema.Number),
  },
})

export type Resumed = Event.Payload<typeof Resumed>

export const Removed = Event.durable({
  type: "automation.removed",
  ...options,
  schema: {
    ...Base,
  },
})

export type Removed = Event.Payload<typeof Removed>

export const Triggered = Event.durable({
  type: "automation.triggered",
  ...options,
  schema: {
    ...Base,
    status: Automation.Status,
    runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    failures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    nextDueAt: optional(Schema.NullOr(Schema.Number)),
    retryAt: optional(Schema.NullOr(Schema.Number)),
    lastRunAt: optional(Schema.Number),
    lastOutcome: Automation.Outcome,
    lastOutput: optional(Schema.NullOr(Schema.String)),
    state: optional(Schema.Json),
    cursor: optional(Schema.NullOr(Schema.String)),
    lastEventId: optional(Schema.String),
    dedupKey: optional(Schema.String),
  },
})

export type Triggered = Event.Payload<typeof Triggered>

export const CursorSaved = Event.durable({
  type: "automation.cursor.saved",
  ...options,
  schema: {
    ...Base,
    cursor: Schema.NullOr(Schema.String),
    lastEventId: optional(Schema.String),
  },
})

export type CursorSaved = Event.Payload<typeof CursorSaved>

export const Public = Event.inventory(Created, Paused, Resumed, Removed, Triggered)

export const Internal = Event.inventory(CursorSaved)
