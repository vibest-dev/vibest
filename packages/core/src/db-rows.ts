import { ExecutionOutcome, type InboxKind, ProcessEndReason } from "@vibest/schema/event"
import { MessageStatus } from "@vibest/schema/model"
import { AgentStatus, RuntimeAddress, ExecutionState } from "@vibest/schema/session"
import { Schema } from "effect"

import { Routing } from "./plugins.ts"

export const AddressJson = Schema.fromJsonString(RuntimeAddress)
export const encodeAddress = Schema.encodeSync(AddressJson)

const Live = {
  integration: Schema.optional(Schema.Struct({ version: Schema.String, protocol: Schema.Number })),
  pid: Schema.optional(Schema.Number),
  ready: Schema.optional(Schema.Number),
}

const Metadata = Schema.Struct({
  ...Live,
  routing: Schema.optional(Routing),
  archived: Schema.optional(Schema.Boolean),
  removed: Schema.optional(Schema.Boolean),
  attempts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        harness: Schema.String,
        provider: Schema.optional(Schema.String),
        outcome: Schema.Literal("limited"),
        at: Schema.Number,
      }),
    ),
  ),
})
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
  metadata: Schema.fromJsonString(Metadata),
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
  ...NewSessionFields,
  endedAt: Schema.NullOr(Schema.Number),
  parentId: Schema.NullOr(Schema.String),
  entry: Schema.Boolean,
  process: Schema.NullOr(SessionProcess),
  openExecution: Schema.NullOr(OpenExecution),
  lastExecution: Schema.NullOr(LastExecution),
})
export type SessionRow = typeof SessionRow.Type

export type SessionPatch = Partial<Omit<SessionRow, "id" | "projectId" | "agent" | "createdAt" | "runtime">> & {
  readonly end?: ProcessEndReason
}

export const EntryRow = Schema.Struct({
  id: Schema.String,
  agent: Schema.String,
  projectId: Schema.String,
  harnessId: Schema.String,
  harnessSessionId: Schema.NullOr(Schema.String),
  runtime: Schema.NullOr(Schema.String),
  address: Schema.NullOr(AddressJson),
  projectDirectory: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  routing: Schema.optional(Routing),
  ...Live,
})
export type EntryRow = typeof EntryRow.Type

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

export const ENTRY_AGENT = "entry"
