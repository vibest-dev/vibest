import { ExecutionOutcome, ProcessEndReason, type AgentFrom, type Sender } from "@vibest/schema/event"
import { MessageStatus } from "@vibest/schema/model"
import { Routing } from "@vibest/schema/plugin"
import { AgentStatus, RuntimeAddress, ExecutionState } from "@vibest/schema/session"
import { Schema } from "effect"

export const AddressJson = Schema.fromJsonString(RuntimeAddress)
export const encodeAddress = Schema.encodeSync(AddressJson)

const NewSessionFields = {
  id: Schema.String,
  projectId: Schema.String,
  agent: Schema.String,
  harnessId: Schema.String,
  harnessSessionId: Schema.NullOr(Schema.String),
  runtime: Schema.String,
  address: AddressJson,
  name: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  status: AgentStatus,
  startedAt: Schema.NullOr(Schema.Number),
  exitedAt: Schema.NullOr(Schema.Number),
  executionState: ExecutionState,
  executionPromptedAt: Schema.Number,
  routing: Schema.optional(Routing),
  createdAt: Schema.Number,
  lastActive: Schema.Number,
}

export const NewSession = Schema.Struct(NewSessionFields)

export type NewSession = typeof NewSession.Type

const IntegrationVersion = Schema.Struct({ version: Schema.String, protocol: Schema.Number })

export const SessionProcess = Schema.Struct({
  id: Schema.Number,
  harness: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  routing: Schema.NullOr(Routing),
  runtime: Schema.String,
  machine: Schema.String,
  terminal: Schema.NullOr(Schema.String),
  pid: Schema.NullOr(Schema.Number),
  conversation: Schema.NullOr(Schema.String),
  placedAt: Schema.NullOr(Schema.Number),
  readyAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number),
  endReason: Schema.NullOr(ProcessEndReason),
  integration: Schema.NullOr(IntegrationVersion),
})

export const OpenExecution = Schema.Struct({
  id: Schema.Number,
  process: Schema.NullOr(Schema.Number),
  bookedAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
})

export const LastExecution = Schema.Struct({
  id: Schema.Number,
  process: Schema.NullOr(Schema.Number),
  outcome: ExecutionOutcome,
  startedAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number),
  reply: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.Struct({ message: Schema.String, kind: Schema.optional(Schema.Literal("limit")) })),
})

export const SessionRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  agent: Schema.String,
  name: Schema.String,
  status: AgentStatus,
  createdAt: Schema.Number,
  lastActive: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  parentId: Schema.NullOr(Schema.String),
  entry: Schema.Boolean,
  process: Schema.NullOr(SessionProcess),
  openExecution: Schema.NullOr(OpenExecution),
  lastExecution: Schema.NullOr(LastExecution),
})

export type SessionRow = typeof SessionRow.Type

export const archived = (row: Pick<SessionRow, "entry" | "endedAt">) => !row.entry && row.endedAt !== null

export const exitedAt = (row: Pick<SessionRow, "entry" | "endedAt" | "process">) =>
  row.entry ? row.endedAt : (row.process?.endedAt ?? null)

export const sessionEnded = (row: SessionRow | undefined) =>
  row === undefined || exitedAt(row) !== null || archived(row)

export const terminalOf = (row: Pick<SessionRow, "process">): RuntimeAddress => ({
  machine: "local",
  id: row.process?.terminal ?? "",
})

export const runtimeOf = (row: Pick<SessionRow, "process">) => row.process?.runtime ?? ""

export const harnessIdOf = (row: Pick<SessionRow, "process">) => row.process?.harness ?? ""

export const placedTerminal = (row: Pick<SessionRow, "process">) => {
  const process = row.process

  return process === null || process.endedAt !== null || process.terminal === null || process.runtime === ""
    ? undefined
    : { runtime: process.runtime, address: { machine: "local", id: process.terminal } }
}

export const startOf = (row: Pick<SessionRow, "process">): ProcessStart => {
  const process = row.process

  return {
    harness: process?.harness ?? "",
    ...(process?.provider && { provider: process.provider }),
    ...(process?.model && { model: process.model }),
    ...(process?.routing && { routing: process.routing }),
    runtime: process?.runtime ?? "",
    terminal: "",
    ...(process?.conversation && { resume: process.conversation }),
  }
}

export const pidOf = (row: Pick<SessionRow, "process">) => row.process?.pid ?? undefined

export const reportedOf = (row: SessionRow | undefined) =>
  row?.process == null
    ? undefined
    : {
        pid: row.process.pid ?? undefined,
        ready: row.process.readyAt ?? undefined,
        integration: row.process.integration ?? undefined,
      }

export const executionStateOf = (row: Pick<SessionRow, "openExecution" | "lastExecution">) =>
  row.openExecution !== null ? "open" : (row.lastExecution?.outcome ?? "none")

export const executionStartedAt = (row: Pick<SessionRow, "openExecution" | "lastExecution">) =>
  row.openExecution?.bookedAt ?? 0

export type NewInboxRow = {
  readonly sessionId: string
  readonly message: string
}

export type SpawnedBefore = {
  readonly id: string
  readonly harness: string
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly runtime: string
  readonly routing: typeof Routing.Type | undefined
}

export type RepositoryRow = { readonly path: string; readonly remote: string | undefined }

export type ProcessStart = {
  readonly harness: string
  readonly provider?: string
  readonly model?: string
  readonly routing?: Routing
  readonly runtime: string
  readonly terminal: string
  readonly resume?: string
  readonly pid?: number
}

export type Integration = { readonly version: string; readonly protocol: number }

export const senderKey = (sender: Sender) => {
  if (sender.type === "plugin") return `plugin:${sender.plugin}`

  return sender.type === "agent" ? `${sender.machine ?? ""}/${sender.session}` : sender.type
}

export const localSessionOf = (sender: Sender) =>
  sender.type === "agent" && sender.machine === undefined ? sender.session : undefined

export type SenderSql = {
  readonly senderType: string
  readonly senderSessionId: string | null
  readonly senderAgent: string | null
  readonly senderTitle: string | null
  readonly senderMachine: string | null
  readonly senderPlugin: string | null
}

export const senderColumns = (sender: Sender) => ({
  type: sender.type,
  session: sender.type === "agent" ? sender.session : null,
  agent: sender.type === "agent" ? (sender.agent ?? null) : null,
  title: sender.type === "agent" ? (sender.title ?? null) : null,
  machine: sender.type === "agent" ? (sender.machine ?? null) : null,
  plugin: sender.type === "plugin" ? sender.plugin : null,
})

export const senderOfRow = (row: SenderSql) => ({
  type: row.senderType,
  ...(row.senderSessionId !== null && { session: row.senderSessionId }),
  ...(row.senderAgent !== null && { agent: row.senderAgent }),
  ...(row.senderTitle !== null && { title: row.senderTitle }),
  ...(row.senderMachine !== null && { machine: row.senderMachine }),
  ...(row.senderPlugin !== null && { plugin: row.senderPlugin }),
})

export type FromSql = {
  readonly fromSession: string | null
  readonly fromAgent: string | null
  readonly fromTitle: string | null
  readonly fromMachine: string | null
}

export const fromOf = (row: FromSql): AgentFrom | null =>
  row.fromSession === null
    ? null
    : {
        session: row.fromSession,
        ...(row.fromAgent !== null && { agent: row.fromAgent }),
        ...(row.fromTitle !== null && { title: row.fromTitle }),
        ...(row.fromMachine !== null && { machine: row.fromMachine }),
      }

export type InboxSql = SenderSql & {
  readonly id: number
  readonly sessionId: string
  readonly kind: string
  readonly content: string
  readonly status: string
}

export type ExecutionEnd = {
  readonly outcome: typeof ExecutionOutcome.Type
  readonly failure?: ExecutionFailure
  readonly conversation?: string
  readonly reply?: string
}

export type ExecutionFailure = { readonly message: string; readonly kind?: "limit"; readonly resetAt?: number }

export const failureOf = (error: string | undefined): ExecutionFailure | undefined =>
  error === undefined || error === "" ? undefined : { message: error }

export const limitFailure = (message: string, resetAt: number | undefined): ExecutionFailure => ({
  message,
  kind: "limit",
  ...(resetAt !== undefined && { resetAt }),
})

export type LimitAbout = {
  readonly provider?: string | undefined
  readonly windows?: ReadonlyArray<string> | undefined
}

export const limitText = (failure: ExecutionFailure, about: LimitAbout = {}) => {
  const details = [
    ...(about.provider === undefined ? [] : [`provider ${about.provider}`]),
    ...(about.windows === undefined || about.windows.length === 0 ? [] : [`${about.windows.join(", ")} exhausted`]),
    failure.resetAt === undefined ? "no reset time reported" : `resets ${new Date(failure.resetAt).toISOString()}`,
  ]

  return `${failure.message} (${details.join("; ")})`
}

export const toInbox = (row: InboxSql) => {
  return {
    id: row.id,
    sender: senderOfRow(row),
    recipient: row.sessionId,
    kind: row.kind,
    message: row.content,
    status: row.status,
  }
}

export const isMessageStatus = Schema.is(MessageStatus)

export const decodeRoutingJson = Schema.decodeSync(Schema.fromJsonString(Routing))

export type MessageStatusName = typeof MessageStatus.Type

export type SessionBrief = {
  readonly task: string | null
  readonly latest: {
    readonly status: MessageStatusName
    readonly summary: string
    readonly endedAt: number | null
  } | null
}
