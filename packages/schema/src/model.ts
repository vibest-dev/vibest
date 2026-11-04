// The four tables in docs/design/schema.md. Times are epoch milliseconds; JSON columns are decoded here.
import { Schema } from "effect"

import { ID } from "./id.ts"

export const ProjectID = Schema.brand("ProjectID")(Schema.Int)
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
  /** The project directory. Its display name is the directory's name. */
  directory: Schema.String,
  /** The current main conversation. */
  mainSessionId: Schema.optional(SessionID),
})
export type Project = typeof Project.Type

/** `{ type, … }` as the runtime stored it. herdr: `{ type: "herdr", session, pane }`. */
export const Runtime = Json
export type Runtime = typeof Runtime.Type

/** One row per Agent run: one CLI process in one pane. */
export const Session = Schema.Struct({
  /** A UUIDv4 (`newId`), shown to the user by its first 8 characters. */
  id: SessionID,
  projectId: ProjectID,
  /** The session that started it. Absent: the user. */
  parentSessionId: Schema.optional(SessionID),
  /** The Agent definition: main, general, planner, reviewer, … */
  agentType: Schema.String,
  /** The CLI: claude | pi | cursor. */
  harness: Schema.String,
  /** Where it works: the project directory or its own worktree. */
  directory: Schema.String,
  /** Absent until the session has been started. */
  runtime: Schema.optional(Runtime),
  /** The CLI's own conversation id, used to resume it. */
  harnessSessionId: Schema.optional(Schema.String),
  /** JSON: provider, model, environment, machine, … */
  metadata: Json,
  createdAt: Time,
  endedAt: Schema.optional(Time),
})
export type Session = typeof Session.Type

export const SenderType = Schema.Literals(["user", "session", "system", "plugin"])
export type SenderType = typeof SenderType.Type
export const DeliveryStatus = Schema.Literals(["pending", "delivering", "delivered", "failed", "dropped"])
export type DeliveryStatus = typeof DeliveryStatus.Type

/** Text waiting for one session, and whether it was delivered. */
export const Inbox = Schema.Struct({
  id: InboxID,
  recipientSessionId: SessionID,
  senderType: SenderType,
  /** The session or plugin id. For a system notice, the session it is about. Absent for a user. */
  senderId: Schema.optional(Schema.String),
  /** The text to deliver. Empty when `resultMessageId` is set. */
  content: Schema.String,
  /** Set when this row reports that message's output. */
  resultMessageId: Schema.optional(MessageID),
  deliveryStatus: DeliveryStatus,
})
export type Inbox = typeof Inbox.Type

export const MessageStatus = Schema.Literals(["working", "completed", "failed", "interrupted", "lost", "not_started"])
export type MessageStatus = typeof MessageStatus.Type

/** One round of work by a session. `working` is the open turn. */
export const Message = Schema.Struct({
  id: MessageID,
  sessionId: SessionID,
  /** The inbox row whose delivery started it. Absent: the user typed into the pane. */
  inboxId: Schema.optional(InboxID),
  /** What the session was given. */
  input: Schema.String,
  /** What it answered. */
  output: Schema.optional(Schema.String),
  status: MessageStatus,
  /** JSON: what was parsed from the answer (summary, branch, pushed, error, …). */
  metadata: Json,
  startedAt: Time,
  endedAt: Schema.optional(Time),
})
export type Message = typeof Message.Type
