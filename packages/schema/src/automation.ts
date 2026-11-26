import { Duration, Option, Schema } from "effect"

import { randomId, SessionId } from "./id.ts"

export * as Automation from "./automation.ts"

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

export const ID = Schema.String.check(Schema.isStartingWith("aut_")).pipe(
  Schema.brand("Automation.ID"),
  Schema.annotate({ identifier: "AutomationId" }),
)

export type ID = typeof ID.Type

export const createId = (now = Date.now()): ID => {
  const time = Math.max(0, Math.trunc(now)).toString(16).padStart(12, "0")
  const rand = randomId().replaceAll("-", "").slice(0, 16)

  return ID.make(`aut_${time}${rand}`)
}

const decodeDuration = Schema.decodeUnknownOption(Schema.DurationFromString)

export const durationMillis = (value: string) => decodeDuration(value).pipe(Option.map(Duration.toMillis))

export const DurationString = Schema.String.annotate({
  identifier: "AutomationDuration",
  description: 'A duration such as "30 seconds", "5 minutes" or "2 hours".',
})

const zone = {
  tz: optional(Schema.String).annotate({
    description: "IANA time zone. Defaults to the server local time zone.",
  }),
}

export const AtTrigger = Schema.Struct({
  type: Schema.tag("at"),
  at: Schema.String.annotate({
    description: 'An instant with an offset, a wall-clock time in tz such as "2026-10-27T09:00", or "in 10 minutes".',
  }),
  ...zone,
}).annotate({ identifier: "AutomationTriggerAt" })

export type AtTrigger = typeof AtTrigger.Type

export const EveryTrigger = Schema.Struct({
  type: Schema.tag("every"),
  every: DurationString,
  ...zone,
}).annotate({ identifier: "AutomationTriggerEvery" })

export type EveryTrigger = typeof EveryTrigger.Type

export const CronTrigger = Schema.Struct({
  type: Schema.tag("cron"),
  cron: Schema.String,
  ...zone,
}).annotate({ identifier: "AutomationTriggerCron" })

export type CronTrigger = typeof CronTrigger.Type

export const WebhookTrigger = Schema.Struct({
  type: Schema.tag("webhook"),
  secretHash: optional(Schema.String),
}).annotate({ identifier: "AutomationTriggerWebhook" })

export type WebhookTrigger = typeof WebhookTrigger.Type

export const EventTrigger = Schema.Struct({
  type: Schema.tag("event"),
  server: Schema.NonEmptyString,
  event: Schema.NonEmptyString,
  args: optional(Schema.Record(Schema.String, Schema.Json)),
}).annotate({ identifier: "AutomationTriggerEvent" })

export type EventTrigger = typeof EventTrigger.Type

export const Trigger = Schema.Union([AtTrigger, EveryTrigger, CronTrigger, WebhookTrigger, EventTrigger]).pipe(
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "AutomationTrigger" }),
)

export type Trigger = typeof Trigger.Type

export const SessionTarget = Schema.Struct({
  sessionId: SessionId,
}).annotate({ identifier: "AutomationTargetSession" })

export type SessionTarget = typeof SessionTarget.Type

export const AgentTarget = Schema.Struct({
  agent: Schema.NonEmptyString,
}).annotate({ identifier: "AutomationTargetAgent" })

export type AgentTarget = typeof AgentTarget.Type

export const Target = Schema.Union([SessionTarget, AgentTarget]).annotate({
  identifier: "AutomationTarget",
})

export type Target = typeof Target.Type

export const PromptAction = Schema.Struct({
  type: Schema.tag("prompt"),
  prompt: Schema.NonEmptyString,
  to: optional(Target),
}).annotate({ identifier: "AutomationActionPrompt" })

export type PromptAction = typeof PromptAction.Type

export const CodeAction = Schema.Struct({
  type: Schema.tag("code"),
  code: Schema.NonEmptyString,
  args: optional(Schema.Json),
  to: optional(Target),
}).annotate({ identifier: "AutomationActionCode" })

export type CodeAction = typeof CodeAction.Type

export const Action = Schema.Union([PromptAction, CodeAction]).pipe(
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "AutomationAction" }),
)

export type Action = typeof Action.Type

export const CodeSend = Schema.Struct({
  prompt: Schema.String.check(Schema.isPattern(/\S/)),
  to: optional(Target),
}).annotate({ identifier: "AutomationCodeSend" })

export type CodeSend = typeof CodeSend.Type

export const CodeResult = Schema.Struct({
  state: optional(Schema.Json),
  done: optional(Schema.Boolean),
  send: optional(CodeSend),
}).annotate({ identifier: "AutomationCodeResult" })

export type CodeResult = typeof CodeResult.Type

export const decodeCodeResult = Schema.decodeUnknownResult(Schema.NullOr(CodeResult), {
  onExcessProperty: "error",
})

export const Status = Schema.Literals(["active", "paused", "done"]).annotate({
  identifier: "AutomationStatus",
})

export type Status = typeof Status.Type

export const Outcome = Schema.Literals(["fired", "late", "skipped", "disabled", "failed", "expired"]).annotate({
  identifier: "AutomationOutcome",
})

export type Outcome = typeof Outcome.Type

export const EventCursor = Schema.Struct({
  cursor: optional(Schema.NullOr(Schema.String)),
  lastEventId: optional(Schema.String),
}).annotate({ identifier: "AutomationEventCursor" })

export type EventCursor = typeof EventCursor.Type

export const Info = Schema.Struct({
  id: ID,
  name: Schema.NonEmptyString,
  projectId: Schema.String,
  sessionId: optional(SessionId),
  directory: Schema.String,
  trigger: Trigger,
  tz: Schema.String,
  action: Action,
  expiresAt: optional(Schema.Number),
  status: Status,
  nextDueAt: optional(Schema.Number),
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastRunAt: optional(Schema.Number),
  lastOutcome: optional(Outcome),
  lastOutput: optional(Schema.String),
  retryAt: optional(Schema.Number),
  state: optional(Schema.Json),
  eventCursor: optional(EventCursor),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: "AutomationInfo" })

export type Info = typeof Info.Type

export const CreateInput = Schema.Struct({
  name: Schema.NonEmptyString,
  trigger: Trigger,
  action: Action,
  directory: optional(Schema.String),
  projectId: optional(Schema.String),
  sessionId: optional(SessionId),
  expires: optional(Schema.String),
  webhookSecret: optional(Schema.NonEmptyString),
}).annotate({ identifier: "AutomationCreateInput" })

export type CreateInput = typeof CreateInput.Type

export const WebhookResult = Schema.Struct({
  automationId: ID,
  accepted: Schema.Boolean,
  deduplicated: Schema.Boolean,
  info: Info,
}).annotate({ identifier: "AutomationWebhookResult" })

export type WebhookResult = typeof WebhookResult.Type

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "AutomationNotFoundError",
  {
    automationId: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class InvalidError extends Schema.TaggedError<InvalidError>()(
  "AutomationInvalidError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class WebhookUnauthorizedError extends Schema.TaggedError<WebhookUnauthorizedError>()(
  "AutomationWebhookUnauthorizedError",
  {
    automationId: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}
