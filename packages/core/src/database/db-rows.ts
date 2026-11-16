import { ExecutionOutcome, type InboxKind, ProcessEndReason } from "@vibest/schema/event"
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

const IntegrationShape = Schema.Struct({ version: Schema.String, protocol: Schema.Number })

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
  integration: Schema.NullOr(IntegrationShape),
})

export const OpenExecution = Schema.Struct({
  id: Schema.Number,
  process: Schema.NullOr(Schema.Number),
  startedAt: Schema.Number,
  acceptedAt: Schema.NullOr(Schema.Number),
})

export const LastExecution = Schema.Struct({
  id: Schema.Number,
  process: Schema.NullOr(Schema.Number),
  outcome: ExecutionOutcome,
  startedAt: Schema.Number,
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
    ...(process?.provider ? { provider: process.provider } : {}),
    ...(process?.model ? { model: process.model } : {}),
    ...(process?.routing ? { routing: process.routing } : {}),
    runtime: process?.runtime ?? "",
    terminal: "",
    ...(process?.conversation ? { resume: process.conversation } : {}),
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
  row.openExecution?.startedAt ?? row.lastExecution?.startedAt ?? 0

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
  readonly routing?: unknown
  readonly runtime: string
  readonly terminal: string
  readonly resume?: string
  readonly pid?: number
}

export type Integration = { readonly version: string; readonly protocol: number }

export const attemptsOf = (raw: string | null) => {
  const seen: Array<{ harness: string; provider?: string; outcome: "limited"; at: number }> = []
  for (const a of JSON.parse(raw ?? "[]") as ReadonlyArray<{ harness: string; provider: string | null; at: number }>) {
    const provider = a.provider ?? undefined
    if (seen.some((s) => s.harness === a.harness && s.provider === provider)) continue
    seen.push({ harness: a.harness, ...(provider === undefined ? {} : { provider }), outcome: "limited", at: a.at })
  }
  return seen
}

export type InboxSql = {
  readonly id: number
  readonly sessionId: string
  readonly kind: string
  readonly senderSessionId: string | null
  readonly content: string
  readonly status: string
}

export type ExecutionEnd = {
  readonly outcome: typeof ExecutionOutcome.Type
  readonly failure?: { readonly message: string; readonly kind?: "limit" }
  readonly conversation?: string
  readonly reply?: string
}

export const failureOf = (error: string | undefined): ExecutionEnd["failure"] =>
  error === undefined || error === "" ? undefined : { message: error }

export const toInbox = (row: InboxSql) => {
  const kind = row.kind as InboxKind
  return {
    id: row.id,
    sender: row.senderSessionId,
    recipient: row.sessionId,
    kind,
    message: row.content,
    status: row.status,
  }
}

export const MESSAGE_STATUSES: ReadonlySet<string> = new Set(MessageStatus.literals)
export type MessageStatusName = typeof MessageStatus.Type

export type SessionBrief = {
  readonly task: string | null
  readonly latest: {
    readonly status: MessageStatusName
    readonly summary: string
    readonly endedAt: number | null
  } | null
}
