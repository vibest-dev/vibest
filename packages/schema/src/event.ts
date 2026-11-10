import { Effect, Schema } from "effect"

import { Routing } from "./plugin.ts"

export type Envelope = "project" | "session" | "none"

export interface Definition<T extends string = string, S extends Schema.Top = Schema.Top> {
  readonly type: T
  readonly envelope: Envelope
  readonly data: S
}

export const fact = <const T extends string, const F extends Schema.Struct.Fields>(
  type: T,
  envelope: Envelope,
  fields: F,
): Definition<T, Schema.Struct<F>> => ({ type, envelope, data: Schema.Struct(fields) })

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
  role: Text,
  name: Text,
  directory: Schema.String,
  parent: optional(Text),
  reportTo: optional(Text),
  archiveOnCompletion: Schema.Boolean,
  origin: optional(Schema.Struct({ peer: Text, project: Text, parent: optional(Text), reportTo: optional(Text) })),
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
export const ProcessEnded = fact("process.ended", "session", { process: Seq, reason: ProcessEndReason })

export const TurnStarted = fact("turn.started", "session", { process: optional(Seq), typed: optional(Text) })
export const TurnReported = fact("turn.reported", "session", {
  process: optional(Seq),
  harness: Text,
  text: Schema.String,
  error: optional(Text),
  conversation: optional(Text),
  interrupted: optional(Schema.Literal(true)),
})
export const TurnStatus = Schema.Literals(["completed", "failed", "interrupted", "lost", "not_started"])
export const TurnEnded = fact("turn.ended", "session", {
  turn: Seq,
  status: TurnStatus,
  report: optional(Seq),
  failure: optional(Schema.Struct({ message: Text })),
})

export const InboxKind = Schema.Literals(["task", "send", "report", "result", "notice"])
export const InboxQueued = fact("inbox.queued", "session", {
  kind: InboxKind,
  recipient: optional(Text),
  sender: optional(Text),
  content: Schema.String,
  status: Schema.Literals(["pending", "delivered", "dropped"]),
  turn: optional(Seq),
  request: optional(Text),
  peerItem: optional(Text),
})
export const InboxMoved = fact("inbox.moved", "session", {
  inbox: Seq,
  to: Schema.Literals(["pending", "delivering", "delivered", "failed", "dropped"]),
  turn: optional(Seq),
})

export const MachineAdded = fact("machine.added", "none", { name: Text, target: Text, vibestd: Text })
export const MachineConnected = fact("machine.connected", "none", { name: Text })
export const MachineRemoved = fact("machine.removed", "none", { name: Text })

export const PeerSeen = fact("peer.seen", "none", { id: Text, name: Text, callsMe: Text })

export const OutboxQueued = fact("outbox.queued", "session", {
  id: Text,
  peer: Text,
  kind: Schema.Literals(["result", "notice"]),
  content: Schema.String,
})
export const OutboxAcked = fact("outbox.acked", "none", { peer: Text, ids: Schema.NonEmptyArray(Text) })

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
  TurnStarted,
  TurnReported,
  TurnEnded,
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

export const CATALOG_VERSION = 1

export type Fact = {
  readonly [D in Defined as D["type"]]: {
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
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly project_id: string | null
  readonly session_id: string | null
  readonly data: string
}

export class UnknownFact extends Schema.TaggedError<UnknownFact>()("UnknownFact", {
  seq: Schema.Number,
  type: Schema.String,
  message: Schema.String,
}) {}

const strict = { onExcessProperty: "error" } as const

const envelopeFits = (envelope: Envelope, row: Pick<Row, "project_id" | "session_id">) =>
  envelope === "none"
    ? row.project_id === null && row.session_id === null
    : envelope === "project"
      ? row.project_id !== null && row.session_id === null
      : row.project_id !== null && row.session_id !== null

export const encodeData = <D extends Defined>(
  definition: D,
  data: D["data"]["Type"],
): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeUnknownEffect(definition.data)(data, strict).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    Effect.tap((json) => Schema.decodeUnknownEffect(definition.data)(JSON.parse(json), strict)),
  )

export const decodeRow = (row: Row): Effect.Effect<Fact, UnknownFact> => {
  const refuse = (message: string) => new UnknownFact({ seq: row.seq, type: row.type, message })
  if (!Object.hasOwn(Catalog, row.type))
    return Effect.fail(refuse(`event ${row.seq}: ${row.type} is not in the event catalog`))
  const definition: Defined = Catalog[row.type as FactType]
  if (!envelopeFits(definition.envelope, row))
    return Effect.fail(refuse(`event ${row.seq}: ${row.type} needs a ${definition.envelope} envelope`))
  return Effect.try({
    try: () => JSON.parse(row.data) as unknown,
    catch: (cause) => refuse(`event ${row.seq}: ${row.type} data is not JSON: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(definition.data)(json, strict).pipe(
        Effect.mapError((cause) => refuse(`event ${row.seq}: ${row.type} does not decode: ${cause.message}`)),
      ),
    ),
    Effect.map(
      (data) =>
        ({
          seq: row.seq,
          at: row.at,
          type: definition.type,
          ...(row.project_id === null ? {} : { projectId: row.project_id }),
          ...(row.session_id === null ? {} : { sessionId: row.session_id }),
          data,
        }) as Fact,
    ),
  )
}
