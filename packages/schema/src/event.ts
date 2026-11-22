import { Effect, Schema } from "effect"

import { factOf } from "./event-fact.ts"
import { Routing } from "./plugin.ts"

export type Aggregate = "project" | "session" | "ledger"

export interface Definition<T extends string = string, S extends Schema.Top = Schema.Top> {
  readonly type: T
  readonly aggregate: Aggregate
  readonly data: S
}

export const fact = <const T extends string, const F extends Schema.Struct.Fields>(
  type: T,
  aggregate: Aggregate,
  fields: F,
): Definition<T, Schema.Struct<F>> => ({ type, aggregate, data: Schema.Struct(fields) })

const Text = Schema.NonEmptyString
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
const Seq = Schema.Int.check(Schema.isGreaterThan(0))
const Pid = Schema.Int.check(Schema.isGreaterThan(0))

const Repository = Schema.Struct({ path: Text, remote: optional(Text) })
const Repositories = Schema.Array(Repository)

export const ProjectCreated = fact("project.created", "project", {
  directory: optional(Text),
  repositories: Repositories,
})

export const ProjectMoved = fact("project.moved", "project", { from: Text, to: Text, repositories: Repositories })

export const ProjectRepositoriesChanged = fact("project.repositories_changed", "project", {
  repositories: Repositories,
})

export const ProjectEntryChanged = fact("project.entry_changed", "project", { session: optional(Text) })

export const SessionCreated = fact("session.created", "session", {
  project: Text,
  agent: Text,
  name: Text,
  directory: Schema.String,
  parent: optional(Text),
  origin: optional(Schema.Struct({ peer: Text, project: Text, session: optional(Text) })),
  message: optional(Seq),
})

export const SessionRenamed = fact("session.renamed", "session", { name: Text })
export const SessionDirectoryChanged = fact("session.directory_changed", "session", { directory: Text })
export const SessionEnded = fact("session.ended", "session", { reason: Schema.Literals(["archived", "replaced"]) })

export const ProcessStarted = fact("process.started", "session", {
  harness: Text,
  provider: optional(Text),
  model: optional(Text),
  routing: optional(Routing),
  resume: optional(Text),
  runtime: Text,
  terminal: optional(Text),
  pid: optional(Pid),
})

export const ProcessPlaced = fact("process.placed", "session", { process: Seq, terminal: Text, pid: optional(Pid) })

export const ProcessReady = fact("process.ready", "session", {
  process: Seq,
  pid: optional(Pid),
  integration: optional(Schema.Struct({ version: Text, protocol: Schema.Int })),
})

export const ProcessPid = fact("process.pid", "session", { process: Seq, pid: Pid })
export const ProcessConversation = fact("process.conversation", "session", { process: Seq, conversation: Text })

export const AgentFrom = Schema.Struct({
  session: Schema.String,
  agent: optional(Schema.String),
  title: optional(Schema.String),
  machine: optional(Schema.String),
})

export type AgentFrom = typeof AgentFrom.Type

export const AgentSender = Schema.Struct({ type: Schema.Literal("agent"), ...AgentFrom.fields })

export type AgentSender = typeof AgentSender.Type

export const PluginSender = Schema.Struct({ type: Schema.Literal("plugin"), plugin: Text })

export const Sender = Schema.Union([
  AgentSender,
  PluginSender,
  Schema.Struct({ type: Schema.Literal("vibest") }),
  Schema.Struct({ type: Schema.Literal("user") }),
])

export type Sender = typeof Sender.Type

export const ProcessEndReason = Schema.Literals([
  "exited",
  "restart",
  "move",
  "archived",
  "launch_failed",
  "superseded",
  "stopped",
])

export type ProcessEndReason = typeof ProcessEndReason.Type

export const ProcessEnded = fact("process.ended", "session", {
  process: Seq,
  reason: ProcessEndReason,
  by: optional(Sender),
})

export const ExecutionStarted = fact("execution.started", "session", {
  process: optional(Seq),
  typed: optional(Text),
})

export const ExecutionAccepted = fact("execution.accepted", "session", { execution: Seq })
export const ExecutionOutcome = Schema.Literals(["completed", "failed", "interrupted", "lost", "not_started"])

export type ExecutionOutcome = typeof ExecutionOutcome.Type

export const ExecutionEnded = fact("execution.ended", "session", {
  execution: Seq,
  outcome: ExecutionOutcome,
  failure: optional(
    Schema.Struct({ message: Text, kind: optional(Schema.Literal("limit")), resetAt: optional(Schema.Number) }),
  ),
  conversation: optional(Text),
  reply: optional(Schema.String),
})

export const InboxHistory = Schema.Literals([
  "route",
  "delivered_without_execution",
  "failed_unspecified",
  "unconfirmed",
  "released",
])

export type InboxHistory = typeof InboxHistory.Type

export const UnrecordedDrop = "unrecorded"

export const InboxEnqueued = fact("inbox.enqueued", "session", {
  sender: Sender,
  content: Schema.String,
  senderExecutionId: optional(Seq),
  requestId: optional(Text),
  transferId: optional(Text),
  aboutSessionId: optional(Text),
})

export const InboxDeliveryStarted = fact("inbox.delivery_started", "session", {
  messageId: Seq,
  execution: optional(Seq),
})

export const InboxDelivered = fact("inbox.delivered", "session", {
  messageId: Seq,
  recipientExecutionId: Seq,
})

export const InboxDeliveryFailed = fact("inbox.delivery_failed", "session", {
  messageId: Seq,
  reason: Text,
})

export const InboxDropped = fact("inbox.dropped", "session", {
  messageId: Seq,
  reason: Text,
})

export const InboxUnresolved = fact("inbox.unresolved", "session", {
  history: InboxHistory,
  messageId: optional(Seq),
  sender: optional(Sender),
  content: optional(Schema.String),
  senderExecutionId: optional(Seq),
  requestId: optional(Text),
  transferId: optional(Text),
  aboutSessionId: optional(Text),
})

export const MachineAdded = fact("machine.added", "ledger", { name: Text, target: Text, vibestd: Text })
export const MachineConnected = fact("machine.connected", "ledger", { name: Text })
export const MachineRemoved = fact("machine.removed", "ledger", { name: Text })

export const PeerSeen = fact("peer.seen", "ledger", { id: Text, name: Text })

export const OutboxQueued = fact("outbox.queued", "ledger", {
  id: Text,
  peer: Text,
  session: Text,
  recipient: optional(Text),
  kind: optional(Schema.Literals(["send", "notice"])),
  content: Schema.String,
  from: optional(AgentFrom),
  execution: optional(Seq),
})

export const OutboxAcked = fact("outbox.acked", "ledger", { peer: Text, ids: Schema.NonEmptyArray(Text) })

export const Catalog = {
  [ProjectCreated.type]: ProjectCreated,
  [ProjectMoved.type]: ProjectMoved,
  [ProjectRepositoriesChanged.type]: ProjectRepositoriesChanged,
  [ProjectEntryChanged.type]: ProjectEntryChanged,
  [SessionCreated.type]: SessionCreated,
  [SessionRenamed.type]: SessionRenamed,
  [SessionDirectoryChanged.type]: SessionDirectoryChanged,
  [SessionEnded.type]: SessionEnded,
  [ProcessStarted.type]: ProcessStarted,
  [ProcessPlaced.type]: ProcessPlaced,
  [ProcessReady.type]: ProcessReady,
  [ProcessPid.type]: ProcessPid,
  [ProcessConversation.type]: ProcessConversation,
  [ProcessEnded.type]: ProcessEnded,
  [ExecutionStarted.type]: ExecutionStarted,
  [ExecutionAccepted.type]: ExecutionAccepted,
  [ExecutionEnded.type]: ExecutionEnded,
  [InboxEnqueued.type]: InboxEnqueued,
  [InboxDeliveryStarted.type]: InboxDeliveryStarted,
  [InboxDelivered.type]: InboxDelivered,
  [InboxDeliveryFailed.type]: InboxDeliveryFailed,
  [InboxDropped.type]: InboxDropped,
  [InboxUnresolved.type]: InboxUnresolved,
  [MachineAdded.type]: MachineAdded,
  [MachineConnected.type]: MachineConnected,
  [MachineRemoved.type]: MachineRemoved,
  [PeerSeen.type]: PeerSeen,
  [OutboxQueued.type]: OutboxQueued,
  [OutboxAcked.type]: OutboxAcked,
} as const

const byType: ReadonlyMap<string, Defined> = new Map(Object.values(Catalog).map((d) => [d.type, d]))

type Defined = (typeof Catalog)[keyof typeof Catalog]

export type FactType = Defined["type"]

export const CATALOG_VERSION = 8

export type Fact = {
  readonly [D in Defined as D["type"]]: {
    readonly aggregate: string
    readonly seq: number
    readonly at: number
    readonly type: D["type"]
    readonly projectId?: string
    readonly sessionId?: string
    readonly data: D["data"]["Type"]
  }
}[FactType]

export type FactOf<T extends FactType> = Extract<Fact, { readonly type: T }>

export interface Row {
  readonly aggregate: string
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly data: string
}

export class UnknownFact extends Schema.TaggedError<UnknownFact>()("UnknownFact", {
  aggregate: Schema.String,
  seq: Schema.Number,
  type: Schema.String,
  message: Schema.String,
}) {}

const strict = { onExcessProperty: "error" } as const

export const encodeData = <D extends Defined>(
  definition: D,
  data: D["data"]["Type"],
): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeUnknownEffect(definition.data)(data, strict).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    Effect.tap((json) => Schema.decodeUnknownEffect(definition.data)(JSON.parse(json), strict)),
  )

export const isFactOf = <T extends FactType>(type: T, fact: Fact): fact is FactOf<T> => fact.type === type

export const decodeRow = (row: Row): Effect.Effect<Fact, UnknownFact> => {
  const where = `event ${row.aggregate} ${row.seq}`

  const refuse = (message: string) =>
    new UnknownFact({ aggregate: row.aggregate, seq: row.seq, type: row.type, message: `${where}: ${message}` })

  const definition = byType.get(row.type)

  if (definition === undefined) return Effect.fail(refuse(`${row.type} is not in the event catalog`))

  return Effect.try({
    try: () => JSON.parse(row.data),
    catch: (cause) => refuse(`${row.type} data is not JSON: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(definition.data)(json, strict).pipe(
        Effect.mapError((cause) => refuse(`${row.type} does not decode: ${cause.message}`)),
      ),
    ),
    Effect.map((data) => factOf(row, definition, data)),
  )
}
