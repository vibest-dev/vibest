import type { Document } from "./schema.js"
import { emitDefs } from "./ts-type.js"

const SHARED_EVENT_DEFS = new Set(["AgentStatus", "PaneScrollInfo"])

export function emitEvents(schema: Document, header: string): string {
  const ev = schema.schemas.event
  const sub = schema.schemas.subscription_event

  return `${header}
// ---- session events ----
${emitDefs(ev.$defs)}

export type EventFrame = { event: EventKind; data: EventData };

// ---- subscription-specific events ----
${emitDefs(sub.$defs, SHARED_EVENT_DEFS)}

export type SubscriptionEventFrame = { event: SubscriptionEventKind; data: SubscriptionEventData };

/** Any frame that can arrive on a subscription connection after the ack. */
export type PushFrame = EventFrame | SubscriptionEventFrame;
`
}
