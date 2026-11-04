// The engine's read model, from the stored facts (docs/architecture.md, storage): a session row as its process, turn
// and ready events say, an inbox row as its result's `turn.end` says. Pure: every store implementation (vibest's SQLite
// store, the in-memory one) reads its facts into these shapes and derives the rows the port returns here.
import { MessageStatus } from "@vibest/schema/model"
import { Effect, Schema } from "effect"

import {
  type AgentStatus,
  type InboxKind,
  type InboxStatus,
  type Integration,
  ROUND_STATUS,
  SessionRow,
  type TurnEnd,
} from "./db.ts"

export const newId = Effect.sync(() =>
  Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, "0"),
)

/** `process.start` data (schema.md): the choice and where it runs. An empty terminal: chosen, its terminal not open yet. */
export type ProcessStart = {
  readonly harness: string
  readonly provider?: string
  readonly model?: string
  readonly routing?: unknown
  readonly runtime: string
  readonly machine: string
  readonly terminal: string
  /** The conversation id it continues (or was given before its first start). */
  readonly resume?: string
  /** The harness's pid when vibest itself execs it (the main agent), before its integration reports one. */
  readonly pid?: number
}

/** One session row with what its events say, as a store reads it. */
export type SessionFacts = {
  readonly id: string
  readonly scope: string
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

/** A session's current process, as its latest `process.start` and what followed it say. */
export type Current = {
  readonly id: number
  readonly start: ProcessStart
  readonly at: number
  readonly ended: number | null
}

export const currentOf = (row: SessionFacts): Current | undefined =>
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

export const fromColumns = (row: SessionFacts, status: AgentStatus, integration: Integration | undefined) => {
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
    scope: row.scope,
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

/** Public `sending` is the column value `delivering`. */
export const storedStatus = (status: InboxStatus) => (status === "sending" ? "delivering" : status)

export type InboxFacts = {
  readonly id: number
  readonly recipientSessionId: string | null
  readonly kind: string
  readonly senderSessionId: string | null
  readonly content: string
  readonly status: string
  readonly turnEnd: string | null
}

/** The text between `<summary>` and `</summary>` of a rendered result, unescaped; undefined without one. */
export const summaryIn = (content: string) => {
  const found = /<summary>([\s\S]*?)<\/summary>/.exec(content)
  return found === null
    ? undefined
    : found[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
}

/** What a result row says, from the `turn.end` it reports and its rendered text. */
export const resultDetails = (content: string, end: TurnEnd | undefined) => {
  const error = end?.failure?.message
  const summary = summaryIn(content)
  return {
    status: end?.status === "completed" && error === undefined ? "completed" : "failed",
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
  }
}

export const toInbox = (row: InboxFacts) => {
  const kind = row.kind as InboxKind
  const sessionId =
    kind === "send" || kind === "task" ? row.recipientSessionId! : (row.senderSessionId ?? row.recipientSessionId ?? "")
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

export const roundStatus = (status: unknown): TurnEnd["status"] =>
  typeof status === "string" && (ROUND_STATUS as readonly string[]).includes(status)
    ? (status as TurnEnd["status"])
    : "completed"
