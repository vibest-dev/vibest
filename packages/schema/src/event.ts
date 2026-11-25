import { Effect, Schema } from "effect"

import { factOf } from "./event-fact.ts"
import { Routing } from "./plugin.ts"
import { TerminalTarget } from "./terminal.ts"

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

export const SessionCreated = fact("session.created", "session", {
  project: Text,
  agent: Text,
  name: Text,
  directory: Schema.String,
  parent: optional(Text),
  origin: optional(Schema.Struct({ remote: Text, project: Text, session: optional(Text) })),
  message: optional(Seq),
})

export const SessionRenamed = fact("session.renamed", "session", { name: Text })
export const SessionDirectoryChanged = fact("session.directory_changed", "session", { directory: Text })
export const SessionArchived = fact("session.archived", "session", {})
export const SessionLinked = fact("session.linked", "session", { to: Text, remote: optional(Text) })
export const SessionUnlinked = fact("session.unlinked", "session", { to: Text, remote: optional(Text) })

export const ProcessStarted = fact("process.started", "session", {
  harness: Text,
  provider: optional(Text),
  model: optional(Text),
  routing: optional(Routing),
  resume: optional(Text),
  runtime: Text,
  terminal: optional(TerminalTarget),
  pid: optional(Pid),
})

export const ProcessUpdated = fact("process.updated", "session", {
  process: Seq,
  terminal: optional(TerminalTarget),
  pid: optional(Pid),
  conversation: optional(Text),
})

export const ProcessReady = fact("process.ready", "session", {
  process: Seq,
  pid: optional(Pid),
  integration: optional(Schema.Struct({ version: Text, protocol: Schema.Int })),
})

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

export const ExecutionOutcome = Schema.Literals(["completed", "failed", "interrupted", "lost", "not_started"])

export type ExecutionOutcome = typeof ExecutionOutcome.Type

export const ExecutionObservation = Schema.Literals(["lost", "not_started"])

export type ExecutionObservation = typeof ExecutionObservation.Type

export const ExecutionFailure = Schema.Struct({
  message: Text,
  kind: optional(Schema.Literal("limit")),
  resetAt: optional(Schema.Number),
})

export type ExecutionFailure = typeof ExecutionFailure.Type

export const ExecutionAllocated = fact("session.execution.allocated", "session", {
  executionId: Seq,
  processId: optional(Seq),
  typed: optional(Text),
})

export const ExecutionStarted = fact("session.execution.started", "session", {
  executionId: Seq,
  processId: optional(Seq),
})

export const ExecutionSucceeded = fact("session.execution.succeeded", "session", {
  executionId: Seq,
  reply: optional(Schema.String),
})

export const ExecutionFailed = fact("session.execution.failed", "session", {
  executionId: Seq,
  failure: ExecutionFailure,
  reply: optional(Schema.String),
})

export const ExecutionInterrupted = fact("session.execution.interrupted", "session", {
  executionId: Seq,
  reason: optional(Text),
  reply: optional(Schema.String),
})

export const ExecutionUnresolved = fact("session.execution.unresolved", "session", {
  executionId: Seq,
  observation: ExecutionObservation,
  failure: optional(ExecutionFailure),
  reply: optional(Schema.String),
})

export const ExecutionInput = fact("session.execution.input", "session", {
  executionId: Seq,
  typed: Text,
})

export const InboxEnqueued = fact("session.inbox.enqueued", "session", {
  sender: Sender,
  content: Schema.String,
  senderExecutionId: optional(Seq),
  requestId: optional(Text),
  transferId: optional(Text),
  aboutSessionId: optional(Text),
})

export const InboxDelivering = fact("session.inbox.delivering", "session", {
  messageId: Seq,
  execution: optional(Seq),
})

export const InboxDelivered = fact("session.inbox.delivered", "session", {
  messageId: Seq,
  recipientExecutionId: Seq,
})

export const InboxFailed = fact("session.inbox.failed", "session", {
  messageId: Seq,
  reason: Text,
})

export const InboxDropped = fact("session.inbox.dropped", "session", {
  messageId: Seq,
  reason: Text,
})

export const MachineAdded = fact("machine.added", "ledger", { name: Text, target: Text, remote: Text })
export const MachineConnected = fact("machine.connected", "ledger", { name: Text })
export const MachineRemoved = fact("machine.removed", "ledger", { name: Text })

export const RemoteSeen = fact("remote.seen", "ledger", { id: Text, name: Text })

export const OutboxQueued = fact("remote.outbox.queued", "ledger", {
  id: Text,
  remote: Text,
  session: Text,
  recipient: optional(Text),
  kind: optional(Schema.Literals(["send", "notice"])),
  content: Schema.String,
  from: optional(AgentFrom),
  execution: optional(Seq),
})

export const OutboxAcked = fact("remote.outbox.acked", "ledger", { remote: Text, ids: Schema.NonEmptyArray(Text) })

export const PublicCatalog = {
  [ProjectCreated.type]: ProjectCreated,
  [ProjectMoved.type]: ProjectMoved,
  [ProjectRepositoriesChanged.type]: ProjectRepositoriesChanged,
  [SessionCreated.type]: SessionCreated,
  [SessionRenamed.type]: SessionRenamed,
  [SessionDirectoryChanged.type]: SessionDirectoryChanged,
  [SessionArchived.type]: SessionArchived,
  [SessionLinked.type]: SessionLinked,
  [SessionUnlinked.type]: SessionUnlinked,
  [ProcessStarted.type]: ProcessStarted,
  [ProcessReady.type]: ProcessReady,
  [ProcessEnded.type]: ProcessEnded,
  [ExecutionAllocated.type]: ExecutionAllocated,
  [ExecutionStarted.type]: ExecutionStarted,
  [ExecutionSucceeded.type]: ExecutionSucceeded,
  [ExecutionFailed.type]: ExecutionFailed,
  [ExecutionInterrupted.type]: ExecutionInterrupted,
  [ExecutionUnresolved.type]: ExecutionUnresolved,
  [ExecutionInput.type]: ExecutionInput,
  [InboxEnqueued.type]: InboxEnqueued,
  [InboxDelivered.type]: InboxDelivered,
  [InboxFailed.type]: InboxFailed,
  [InboxDropped.type]: InboxDropped,
  [MachineAdded.type]: MachineAdded,
  [MachineRemoved.type]: MachineRemoved,
} as const

export const Catalog = {
  ...PublicCatalog,
  [ProcessUpdated.type]: ProcessUpdated,
  [InboxDelivering.type]: InboxDelivering,
  [MachineConnected.type]: MachineConnected,
  [RemoteSeen.type]: RemoteSeen,
  [OutboxQueued.type]: OutboxQueued,
  [OutboxAcked.type]: OutboxAcked,
} as const

const byType: ReadonlyMap<string, Defined> = new Map(Object.values(Catalog).map((d) => [d.type, d]))

type Defined = (typeof Catalog)[keyof typeof Catalog]

export type FactType = Defined["type"]

export const CATALOG_VERSION = 16

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

type PublicDefined = (typeof PublicCatalog)[keyof typeof PublicCatalog]

export type PublicFactType = PublicDefined["type"]

export type PublicFact = Extract<Fact, { readonly type: PublicFactType }>

export type PublicFactOf<T extends PublicFactType> = Extract<PublicFact, { readonly type: T }>

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
