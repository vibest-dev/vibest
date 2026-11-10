import { Schema } from "effect"

import { Routing } from "./plugin.ts"

export const fact = <const Type extends string, const Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => ({ type, data: Schema.Struct(fields) })

const Text = Schema.NonEmptyString
const Seq = Schema.Int.check(Schema.isGreaterThan(0))
const Pid = Schema.Int.check(Schema.isGreaterThan(0))
const SessionId = Text
const ProcessRef = { process: Seq }
const InboxRef = { inbox: Seq }

export const Repository = Schema.Struct({ path: Text, remoteUrl: Schema.optionalKey(Text) })
export const ProcessEndReason = Schema.Literals(["exited", "limited", "restart", "move", "archived", "launch_failed"])
export const TurnStatus = Schema.Literals(["completed", "failed", "interrupted", "lost", "not_started"])
export const InboxQueuedKind = Schema.Literals(["task", "send", "report", "result", "notice"])

export const ProjectCreated = fact("project.created", {
  directory: Schema.optionalKey(Text),
  repositories: Schema.Array(Repository),
})
export const ProjectMoved = fact("project.moved", { directory: Text })
export const ProjectRepositoriesChanged = fact("project.repositories_changed", {
  repositories: Schema.Array(Repository),
})
export const ProjectEntryChanged = fact("project.entry_changed", { session: Schema.optionalKey(SessionId) })

export const SessionCreated = fact("session.created", {
  role: Text,
  name: Text,
  machine: Text,
  directory: Text,
  parent: Schema.optionalKey(SessionId),
  reportTo: Schema.optionalKey(SessionId),
  archiveOnCompletion: Schema.Boolean,
  origin: Schema.optionalKey(
    Schema.Struct({
      peer: Text,
      project: Text,
      parent: Schema.optionalKey(Text),
      reportTo: Schema.optionalKey(Text),
    }),
  ),
})
export const SessionRenamed = fact("session.renamed", { name: Text })
export const SessionEnded = fact("session.ended", { reason: Schema.Literals(["archived", "replaced"]) })

export const ProcessStarted = fact("process.started", {
  harness: Text,
  provider: Schema.optionalKey(Text),
  model: Schema.optionalKey(Text),
  routing: Schema.optionalKey(Routing),
  resume: Schema.optionalKey(Text),
  runtime: Text,
  machine: Text,
})
export const ProcessPlaced = fact("process.placed", { ...ProcessRef, terminal: Text, pid: Schema.optionalKey(Pid) })
export const ProcessReady = fact("process.ready", {
  ...ProcessRef,
  pid: Schema.optionalKey(Pid),
  integration: Schema.optionalKey(Schema.Struct({ version: Text, protocol: Schema.Int })),
})
export const ProcessConversation = fact("process.conversation", { ...ProcessRef, conversation: Text })
export const ProcessEnded = fact("process.ended", { ...ProcessRef, reason: ProcessEndReason })

export const TurnStarted = fact("turn.started", { process: Schema.optionalKey(Seq), typed: Schema.optionalKey(Text) })
export const TurnReported = fact("turn.reported", {
  process: Schema.optionalKey(Seq),
  harness: Text,
  text: Schema.String,
  error: Schema.optionalKey(Text),
  conversation: Schema.optionalKey(Text),
  interrupted: Schema.optionalKey(Schema.Literal(true)),
})
export const TurnEnded = fact("turn.ended", {
  turn: Seq,
  status: TurnStatus,
  report: Schema.optionalKey(Seq),
  failure: Schema.optionalKey(Schema.Struct({ message: Text })),
})

export const InboxQueued = fact("inbox.queued", {
  kind: InboxQueuedKind,
  recipient: Schema.optionalKey(SessionId),
  sender: Schema.optionalKey(SessionId),
  content: Schema.String,
  turn: Schema.optionalKey(Seq),
  request: Schema.optionalKey(Text),
})
export const InboxLeased = fact("inbox.leased", InboxRef)
export const InboxReleased = fact("inbox.released", InboxRef)
export const InboxDelivered = fact("inbox.delivered", { ...InboxRef, turn: Schema.optionalKey(Seq) })
export const InboxFailed = fact("inbox.failed", InboxRef)
export const InboxDropped = fact("inbox.dropped", InboxRef)

export const Facts = [
  ProjectCreated,
  ProjectMoved,
  ProjectRepositoriesChanged,
  ProjectEntryChanged,
  SessionCreated,
  SessionRenamed,
  SessionEnded,
  ProcessStarted,
  ProcessPlaced,
  ProcessReady,
  ProcessConversation,
  ProcessEnded,
  TurnStarted,
  TurnReported,
  TurnEnded,
  InboxQueued,
  InboxLeased,
  InboxReleased,
  InboxDelivered,
  InboxFailed,
  InboxDropped,
] as const

export type Fact = (typeof Facts)[number]
export type FactType = Fact["type"]
export type FactData<T extends FactType> = Extract<Fact, { type: T }>["data"]["Type"]
