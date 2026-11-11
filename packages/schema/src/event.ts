import { Effect, Schema } from "effect"

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
export const ProcessEndReason = Schema.Literals([
  "exited",
  "limited",
  "restart",
  "move",
  "archived",
  "launch_failed",
  "superseded",
])
export type ProcessEndReason = typeof ProcessEndReason.Type
export const ProcessEnded = fact("process.ended", "session", { process: Seq, reason: ProcessEndReason })

export const ExecutionStarted = fact("execution.started", "session", {
  process: optional(Seq),
  typed: optional(Text),
})
export const ExecutionAccepted = fact("execution.accepted", "session", { execution: Seq })
export const ExecutionOutcome = Schema.Literals(["completed", "failed", "interrupted", "lost", "not_started"])
export const ExecutionEnded = fact("execution.ended", "session", {
  execution: Seq,
  outcome: ExecutionOutcome,
  failure: optional(Schema.Struct({ message: Text, kind: optional(Schema.Literal("limit")) })),
  conversation: optional(Text),
  reply: optional(Schema.String),
})

export const InboxKind = Schema.Literals(["task", "send", "notice"])
export type InboxKind = typeof InboxKind.Type
export const InboxQueued = fact("inbox.queued", "session", {
  kind: InboxKind,
  recipient: optional(Text),
  sender: optional(Text),
  content: Schema.String,
  status: Schema.Literals(["pending", "delivered", "dropped"]),
  request: optional(Text),
  peerItem: optional(Text),
})
export const InboxMoved = fact("inbox.moved", "session", {
  inbox: Seq,
  to: Schema.Literals(["pending", "delivering", "delivered", "failed", "dropped"]),
  execution: optional(Seq),
})

export const MachineAdded = fact("machine.added", "ledger", { name: Text, target: Text, vibestd: Text })
export const MachineConnected = fact("machine.connected", "ledger", { name: Text })
export const MachineRemoved = fact("machine.removed", "ledger", { name: Text })

export const PeerSeen = fact("peer.seen", "ledger", { id: Text, name: Text })

export const OutboxQueued = fact("outbox.queued", "ledger", {
  id: Text,
  peer: Text,
  session: Text,
  content: Schema.String,
})
export const OutboxAcked = fact("outbox.acked", "ledger", { peer: Text, ids: Schema.NonEmptyArray(Text) })

const definitions = [
  ProjectCreated,
  ProjectMoved,
  ProjectRepositoriesChanged,
  ProjectEntryChanged,
  SessionCreated,
  SessionRenamed,
  SessionDirectoryChanged,
  SessionEnded,
  ProcessStarted,
  ProcessPlaced,
  ProcessReady,
  ProcessPid,
  ProcessConversation,
  ProcessEnded,
  ExecutionStarted,
  ExecutionAccepted,
  ExecutionEnded,
  InboxQueued,
  InboxMoved,
  MachineAdded,
  MachineConnected,
  MachineRemoved,
  PeerSeen,
  OutboxQueued,
  OutboxAcked,
] as const

type Defined = (typeof definitions)[number]

export type FactType = Defined["type"]

export const Catalog = Object.fromEntries(definitions.map((d) => [d.type, d])) as {
  readonly [D in Defined as D["type"]]: D
}

export const CATALOG_VERSION = 2

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

export const decodeRow = (row: Row): Effect.Effect<Fact, UnknownFact> => {
  const where = `event ${row.aggregate} ${row.seq}`
  const refuse = (message: string) =>
    new UnknownFact({ aggregate: row.aggregate, seq: row.seq, type: row.type, message: `${where}: ${message}` })
  if (!Object.hasOwn(Catalog, row.type)) return Effect.fail(refuse(`${row.type} is not in the event catalog`))
  const definition: Defined = Catalog[row.type as FactType]
  return Effect.try({
    try: () => JSON.parse(row.data) as unknown,
    catch: (cause) => refuse(`${row.type} data is not JSON: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(definition.data)(json, strict).pipe(
        Effect.mapError((cause) => refuse(`${row.type} does not decode: ${cause.message}`)),
      ),
    ),
    Effect.map(
      (data) =>
        ({
          aggregate: row.aggregate,
          seq: row.seq,
          at: row.at,
          type: definition.type,
          ...(definition.aggregate === "project" ? { projectId: row.aggregate } : {}),
          ...(definition.aggregate === "session" ? { sessionId: row.aggregate } : {}),
          data,
        }) as Fact,
    ),
  )
}
