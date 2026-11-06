import type { JSONSchema } from "./schema.js"
import { emitDefs } from "./ts-type.js"

const DEFINED_IDENTICALLY_IN_BOTH_EVENT_NAMESPACES = new Set(["AgentStatus", "PaneScrollInfo"])

export function emitEvents(schema: JSONSchema, header: string): string {
  const ev = schema.schemas.event as JSONSchema
  const sub = schema.schemas.subscription_event as JSONSchema
  return `${header}
// ---- session events ----
${emitDefs(ev.$defs)}

export type EventFrame = { event: EventKind; data: EventData };

// ---- subscription-specific events ----
${emitDefs(sub.$defs, DEFINED_IDENTICALLY_IN_BOTH_EVENT_NAMESPACES)}

export type SubscriptionEventFrame = { event: SubscriptionEventKind; data: SubscriptionEventData };

/** Any frame that can arrive on a subscription connection after the ack. */
export type PushFrame = EventFrame | SubscriptionEventFrame;
`
}
