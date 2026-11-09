import { MessageStatus } from "@vibest/schema/model"
import { AgentStatus, InboxKind, InboxRow, InboxStatus, RuntimeAddress, TurnState } from "@vibest/schema/session"
import { Schema } from "effect"

import { HARNESS_IDS } from "./harness.ts"
import { Routing } from "./plugins.ts"
import type { TurnEnded } from "./results.ts"

export const AddressJson = Schema.fromJsonString(RuntimeAddress)
export const encodeAddress = Schema.encodeSync(AddressJson)

export const Live = {
  integration: Schema.optional(Schema.Struct({ version: Schema.String, protocol: Schema.Number })),
  pid: Schema.optional(Schema.Number),
  ready: Schema.optional(Schema.Number),
}

export const Metadata = Schema.Struct({
  ...Live,
  routing: Schema.optional(Routing),
  archive: Schema.optional(Schema.Boolean),
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
export const SessionRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  agent: Schema.String,
  harnessId: Schema.Literals(HARNESS_IDS),
  harnessSessionId: Schema.NullOr(Schema.String),
  runtime: Schema.String,
  address: AddressJson,
  name: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  status: AgentStatus,
  startedAt: Schema.NullOr(Schema.Number),
  exitedAt: Schema.NullOr(Schema.Number),
  turnState: TurnState,
  turnPromptedAt: Schema.Number,
  metadata: Schema.fromJsonString(Metadata),
  createdAt: Schema.Number,
  lastActive: Schema.Number,
})
export type SessionRow = typeof SessionRow.Type

export type EndReason = "exited" | "limited" | "restart" | "move" | "archived" | "launch_failed"

export type SessionPatch = Partial<Omit<SessionRow, "id" | "projectId" | "agent" | "createdAt" | "runtime">> & {
  readonly end?: EndReason
}

export const CoordinatorRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  harnessId: Schema.Literals(HARNESS_IDS),
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
export type CoordinatorRow = typeof CoordinatorRow.Type

export type NewInboxRow = Omit<InboxRow, "id" | "status" | "createdAt">

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
  readonly machine: string
  readonly terminal: string
  readonly resume?: string
  readonly pid?: number
}

export type Integration = { readonly version: string; readonly protocol: number }

export type SessionSql = {
  readonly id: string
  readonly project: string
  readonly role: string
  readonly name: string
  readonly machine: string
  readonly archive: number
  readonly createdAt: number
  readonly endedAt: number | null
  readonly pId: number | null
  readonly pAt: number | null
  readonly pData: string | null
  readonly pEnded: number | null
  readonly pid: number | null
  readonly readyAt: number | null
  readonly integration: string | null
  readonly conversation: string | null
  readonly tId: number | null
  readonly tAt: number | null
  readonly tEnd: string | null
  readonly lastAt: number | null
  readonly attempts: string | null
}

export type Current = {
  readonly id: number
  readonly start: ProcessStart
  readonly at: number
  readonly ended: number | null
}

export const currentOf = (row: SessionSql): Current | undefined =>
  row.pId === null || row.pData === null || row.pAt === null
    ? undefined
    : { id: row.pId, start: JSON.parse(row.pData) as ProcessStart, at: row.pAt, ended: row.pEnded }

export const attemptsOf = (raw: string | null) => {
  const seen: Array<{ harness: string; provider?: string; outcome: "limited"; at: number }> = []
  for (const a of JSON.parse(raw ?? "[]") as ReadonlyArray<{ harness: string; provider: string | null; at: number }>) {
    const provider = a.provider ?? undefined
    if (seen.some((s) => s.harness === a.harness && s.provider === provider)) continue
    seen.push({ harness: a.harness, ...(provider === undefined ? {} : { provider }), outcome: "limited", at: a.at })
  }
  return seen
}

export const fromColumns = (row: SessionSql, status: AgentStatus, integration: Integration | undefined) => {
  const p = currentOf(row)
  const start = p?.start
  const ended = row.endedAt !== null
  const integrationNow =
    integration ?? (row.integration !== null ? (JSON.parse(row.integration) as Integration) : undefined)
  const pid = row.pid ?? start?.pid ?? null
  const attempts = attemptsOf(row.attempts)
  const metadata = {
    ...(integrationNow === undefined ? {} : { integration: integrationNow }),
    ...(pid === null ? {} : { pid }),
    ...(row.readyAt === null ? {} : { ready: row.readyAt }),
    ...(start?.routing === undefined ? {} : { routing: start.routing }),
    ...(row.archive === 1 ? { archive: true } : {}),
    ...(ended && row.role !== "main" ? { archived: true, removed: true } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
  }
  const started = p !== undefined && start!.terminal !== "" ? p.at : null
  return {
    id: row.id,
    projectId: row.project,
    agent: row.role,
    harnessId: start?.harness ?? "",
    harnessSessionId: row.conversation ?? start?.resume ?? null,
    runtime: start?.runtime ?? "",
    address: JSON.stringify({ machine: start?.machine ?? row.machine, id: start?.terminal ?? "" }),
    name: row.name,
    provider: start?.provider ?? null,
    model: start?.model ?? null,
    status,
    startedAt: started,
    exitedAt: row.role === "main" ? row.endedAt : (p?.ended ?? null),
    turnState:
      row.tId === null ? "none" : row.tEnd === null ? "open" : row.tEnd === "not_started" ? "not_started" : row.tEnd,
    turnPromptedAt: row.tAt ?? 0,
    metadata: JSON.stringify(metadata),
    createdAt: row.createdAt,
    lastActive: row.lastAt ?? row.createdAt,
  }
}
export const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow))

export const storedStatus = (status: InboxStatus) => (status === "sending" ? "delivering" : status)

export type InboxSql = {
  readonly id: number
  readonly recipientSessionId: string | null
  readonly kind: string
  readonly senderSessionId: string | null
  readonly content: string
  readonly status: string
  readonly turnEnd: string | null
}

export const summaryIn = (content: string) => {
  const found = /<summary>([\s\S]*?)<\/summary>/.exec(content)
  return found === null
    ? undefined
    : found[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
}

export const ROUND_STATUS = ["completed", "failed", "interrupted", "lost", "not_started"] as const

export type TurnEnd = {
  readonly status: (typeof ROUND_STATUS)[number]
  readonly output?: string
  readonly report?: number
  readonly failure?: { readonly message: string }
}

export type TurnReport = TurnEnded & { readonly id: number }

export const failureOf = (error: string | undefined): TurnEnd["failure"] =>
  error === undefined || error === "" ? undefined : { message: error }

export const resultDetails = (content: string, end: TurnEnd | undefined) => {
  const error = end?.failure?.message
  const summary = summaryIn(content)
  return {
    status: end?.status === "completed" && error === undefined ? "completed" : "failed",
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
  }
}

export const toInbox = (row: InboxSql) => {
  const kind = row.kind as InboxKind
  const sessionId = kind === "send" ? row.recipientSessionId! : (row.senderSessionId ?? row.recipientSessionId ?? "")
  return {
    id: row.id,
    sessionId,
    kind,
    message: row.content,
    details:
      kind === "result"
        ? JSON.stringify(
            resultDetails(row.content, row.turnEnd === null ? undefined : (JSON.parse(row.turnEnd) as TurnEnd)),
          )
        : "{}",
    status: row.status === "delivering" ? "sending" : row.status,
    createdAt: 0,
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

export type BriefRow = {
  readonly id: string
  readonly task: string | null
  readonly turnId: number | null
  readonly endData: string | null
  readonly endedAt: number | null
  readonly resultContent: string | null
  readonly answer: string | null
}

export const roundStatus = (status: unknown): TurnEnd["status"] =>
  typeof status === "string" && (ROUND_STATUS as readonly string[]).includes(status)
    ? (status as TurnEnd["status"])
    : "completed"
