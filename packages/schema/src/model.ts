import { Schema } from "effect"

import { ID } from "./id.ts"

export const ProjectID = Schema.brand("ProjectID")(Schema.String.check(Schema.isPattern(ID)))
export type ProjectID = typeof ProjectID.Type

export const SessionID = Schema.brand("SessionID")(Schema.String.check(Schema.isPattern(ID)))
export type SessionID = typeof SessionID.Type

export const InboxID = Schema.brand("InboxID")(Schema.Int)
export type InboxID = typeof InboxID.Type

export const MessageID = Schema.brand("MessageID")(Schema.Int)
export type MessageID = typeof MessageID.Type

const Time = Schema.Number
const Json = Schema.Record(Schema.String, Schema.Unknown)

export const Project = Schema.Struct({
  id: ProjectID,
  directory: Schema.String,
  mainSessionId: Schema.optional(SessionID),
})
export type Project = typeof Project.Type

export const Runtime = Json
export type Runtime = typeof Runtime.Type

export const Session = Schema.Struct({
  id: SessionID,
  projectId: ProjectID,
  parentSessionId: Schema.optional(SessionID),
  agentType: Schema.String,
  harness: Schema.String,
  directory: Schema.String,
  runtime: Schema.optional(Runtime),
  harnessSessionId: Schema.optional(Schema.String),
  metadata: Json,
  createdAt: Time,
  endedAt: Schema.optional(Time),
})
export type Session = typeof Session.Type

export const SenderType = Schema.Literals(["user", "session", "system", "plugin"])
export type SenderType = typeof SenderType.Type
export const DeliveryStatus = Schema.Literals(["pending", "delivering", "delivered", "failed", "dropped"])
export type DeliveryStatus = typeof DeliveryStatus.Type

export const Inbox = Schema.Struct({
  id: InboxID,
  recipientSessionId: SessionID,
  senderType: SenderType,
  senderId: Schema.optional(Schema.String),
  content: Schema.String,
  resultMessageId: Schema.optional(MessageID),
  deliveryStatus: DeliveryStatus,
})
export type Inbox = typeof Inbox.Type

export const MessageStatus = Schema.Literals(["working", "completed", "failed", "interrupted", "lost", "not_started"])
export type MessageStatus = typeof MessageStatus.Type

export const Message = Schema.Struct({
  id: MessageID,
  sessionId: SessionID,
  inboxId: Schema.optional(InboxID),
  input: Schema.String,
  output: Schema.optional(Schema.String),
  status: MessageStatus,
  metadata: Json,
  startedAt: Time,
  endedAt: Schema.optional(Time),
})
export type Message = typeof Message.Type
