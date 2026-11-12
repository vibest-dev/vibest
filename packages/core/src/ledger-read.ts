import { type AgentStatus, InboxRow } from "@vibest/schema/session"
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/sql"

import type { MachineRow, OutboxRow } from "./db-remote.ts"
import {
  attemptsOf,
  EntryRow,
  MESSAGE_STATUSES,
  type MessageStatusName,
  SessionRow,
  type Integration,
  type SessionBrief,
  type SpawnedBefore,
  toInbox,
} from "./db-rows.ts"
import { unwrapped } from "./replies.ts"

export const LOCAL_MACHINE = "local"

export type RescheduleSource = {
  readonly working: string
  readonly delivered: string
  readonly parentSessionId: string | undefined
  readonly since: number
}

const retried = (execution: { readonly outcome: string | null }) =>
  execution.outcome === "failed" || execution.outcome === "not_started"

export const latestRun = (rows: ReadonlyArray<{ readonly content: string; readonly sender: string | null }>) => {
  const last = rows.at(-1)
  let from = rows.length
  if (last !== undefined) {
    from = rows.length - 1
    while (from > 0 && rows[from - 1]!.sender === last.sender) from--
  }
  return rows
    .slice(from)
    .map((row) => row.content)
    .join("\n\n")
}

export type SessionColumns = {
  readonly id: string
  readonly project: string
  readonly agent: string
  readonly name: string
  readonly createdAt: number
  readonly endedAt: number | null
  readonly activeAt: number | null
  readonly pId: number | null
  readonly harness: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly routing: string | null
  readonly runtime: string | null
  readonly terminal: string | null
  readonly pid: number | null
  readonly integrationVersion: string | null
  readonly integrationProtocol: number | null
  readonly conversation: string | null
  readonly placedAt: number | null
  readonly readyAt: number | null
  readonly pEnded: number | null
  readonly tId: number | null
  readonly tAt: number | null
  readonly tStatus: string | null
  readonly attempts: string | null
  readonly parent: string | null
  readonly entry: number
  readonly pEndReason: string | null
  readonly oId: number | null
  readonly oProcess: number | null
  readonly oAt: number | null
  readonly oAccepted: number | null
  readonly lId: number | null
  readonly lProcess: number | null
  readonly lOutcome: string | null
  readonly lAt: number | null
  readonly lEnded: number | null
  readonly lReply: string | null
  readonly lFailure: string | null
  readonly lFailureKind: string | null
}

const integrationOf = (row: Pick<SessionColumns, "integrationVersion" | "integrationProtocol">) =>
  row.integrationVersion === null || row.integrationProtocol === null
    ? undefined
    : { version: row.integrationVersion, protocol: row.integrationProtocol }

const addressOf = (terminal: string | null) => JSON.stringify({ machine: LOCAL_MACHINE, id: terminal ?? "" })

export type Live = {
  readonly status: AgentStatus
  readonly integration: Integration | undefined
}

const NOT_LIVE: Live = { status: "unknown", integration: undefined }

const processOf = (row: SessionColumns, integration: Integration | undefined) =>
  row.pId === null
    ? null
    : {
        id: row.pId,
        harness: row.harness ?? "",
        provider: row.provider,
        model: row.model,
        routing: row.routing === null ? null : (JSON.parse(row.routing) as unknown),
        runtime: row.runtime ?? "",
        machine: LOCAL_MACHINE,
        terminal: row.terminal,
        pid: row.pid,
        conversation: row.conversation,
        placedAt: row.placedAt,
        readyAt: row.readyAt,
        endedAt: row.pEnded,
        endReason: row.pEndReason,
        integration: integration ?? null,
      }

const openExecutionOf = (row: SessionColumns) =>
  row.oId === null ? null : { id: row.oId, process: row.oProcess, startedAt: row.oAt ?? 0, acceptedAt: row.oAccepted }

const lastExecutionOf = (row: SessionColumns) =>
  row.lId === null
    ? null
    : {
        id: row.lId,
        process: row.lProcess,
        outcome: row.lOutcome ?? "",
        startedAt: row.lAt ?? 0,
        endedAt: row.lEnded,
        reply: row.lReply,
        failure:
          row.lFailure === null
            ? null
            : { message: row.lFailure, ...(row.lFailureKind === null ? {} : { kind: row.lFailureKind }) },
      }

export const sessionOf = (row: SessionColumns, live: Live = NOT_LIVE) => {
  const integration = live.integration ?? integrationOf(row)
  const attempts = attemptsOf(row.attempts)
  const metadata = {
    ...(integration === undefined ? {} : { integration }),
    ...(row.pid === null ? {} : { pid: row.pid }),
    ...(row.readyAt === null ? {} : { ready: row.readyAt }),
    ...(row.routing === null ? {} : { routing: JSON.parse(row.routing) as unknown }),
    ...(row.endedAt !== null && row.entry !== 1 ? { archived: true, removed: true } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
  }
  return {
    id: row.id,
    projectId: row.project,
    agent: row.agent,
    harnessId: row.harness ?? "",
    harnessSessionId: row.conversation,
    runtime: row.runtime ?? "",
    address: addressOf(row.terminal),
    name: row.name,
    provider: row.provider,
    model: row.model,
    status: live.status,
    startedAt: row.placedAt,
    exitedAt: row.entry === 1 ? row.endedAt : row.pEnded,
    executionState: row.tId === null ? "none" : (row.tStatus ?? "open"),
    executionPromptedAt: row.tAt ?? 0,
    metadata: JSON.stringify(metadata),
    createdAt: row.createdAt,
    lastActive: row.activeAt ?? row.createdAt,
    endedAt: row.endedAt,
    parentId: row.parent,
    entry: row.entry === 1,
    process: processOf(row, integration),
    openExecution: openExecutionOf(row),
    lastExecution: lastExecutionOf(row),
  }
}

export type EntryColumns = SessionColumns & {
  readonly projectDirectory: string | null
  readonly ownDirectory: string
}

export const entryRow = (
  row: EntryColumns,
  live: { readonly integration: Integration | undefined; readonly moving: boolean } = {
    integration: undefined,
    moving: false,
  },
) => {
  const here = row.pId !== null && row.pEnded === null && row.terminal !== null && !live.moving
  const integration = live.integration ?? integrationOf(row)
  const directory = row.projectDirectory || row.ownDirectory
  return {
    id: row.id,
    agent: row.agent,
    projectId: row.project,
    harnessId: row.harness ?? "",
    harnessSessionId: row.conversation,
    runtime: here ? row.runtime : null,
    address: here ? addressOf(row.terminal) : null,
    ...(directory ? { projectDirectory: directory } : {}),
    createdAt: row.createdAt,
    provider: row.provider,
    model: row.model,
    ...(row.routing === null ? {} : { routing: JSON.parse(row.routing) as unknown }),
    ...(integration === undefined ? {} : { integration }),
    ...(row.pid === null ? {} : { pid: row.pid }),
    ...(row.readyAt === null ? {} : { ready: row.readyAt }),
  }
}

export const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow))
const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxRow))
export const decodeEntrySessions = Schema.decodeUnknownEffect(Schema.Array(EntryRow))

type InboxColumns = {
  readonly id: number
  readonly sessionId: string
  readonly senderSessionId: string | null
  readonly kind: string
  readonly content: string
  readonly status: string
}

export const ledgerReads = (sql: SqlClient.SqlClient) => {
  const sessionRows = (where: ReadonlyArray<Statement.Fragment>, filter?: Statement.Fragment) =>
    sql<SessionColumns>`SELECT * FROM (SELECT s.id, s.project_id AS project, s.agent, s.name,
        s.created_at, s.ended_at, s.active_at, s.parent_session_id AS parent,
        EXISTS (SELECT 1 FROM project q WHERE q.entry_session_id = s.id) AS entry,
        p.id AS p_id, p.harness, p.provider, p.model, p.routing, p.runtime, p.terminal, p.pid,
        p.integration_version, p.integration_protocol, p.conversation, p.placed_at, p.ready_at,
        p.ended_at AS p_ended, p.end_reason AS p_end_reason,
        t.id AS t_id, t.started_at AS t_at, t.outcome AS t_status,
        o.id AS o_id, o.process_id AS o_process, o.started_at AS o_at, o.accepted_at AS o_accepted,
        l.id AS l_id, l.process_id AS l_process, l.outcome AS l_outcome, l.started_at AS l_at,
        l.ended_at AS l_ended, l.reply AS l_reply, l.failure AS l_failure, l.failure_kind AS l_failure_kind,
        (SELECT json_group_array(json_object('harness', l.harness, 'provider', l.provider, 'at', l.ended_at))
          FROM (SELECT * FROM process WHERE session_id = s.id AND end_reason = 'limited' ORDER BY id) l) AS attempts
      FROM session s LEFT JOIN process p ON p.session_id = s.id AND p.id = s.process_id
        LEFT JOIN execution t ON t.session_id = s.id AND t.id = (SELECT max(id) FROM execution WHERE session_id = s.id)
        LEFT JOIN execution o ON o.session_id = s.id AND o.outcome IS NULL
        LEFT JOIN execution l ON l.session_id = s.id AND l.id = (SELECT id FROM execution
          WHERE session_id = s.id AND outcome IS NOT NULL ORDER BY coalesce(ended_at, started_at) DESC, id DESC LIMIT 1)
      ${where.length === 0 ? sql`` : sql`WHERE ${sql.and(where)}`})
    ${filter === undefined ? sql`` : sql`WHERE ${filter}`} ORDER BY created_at, id`

  const entryRows = (project?: string) =>
    sql<EntryColumns>`SELECT s.id, s.agent, s.project_id AS project, s.created_at, s.directory AS own_directory,
        q.directory AS project_directory,
        p.id AS p_id, p.harness, p.provider, p.model, p.routing, p.runtime, p.terminal, p.pid,
        p.integration_version, p.integration_protocol, p.conversation, p.ready_at, p.ended_at AS p_ended
      FROM project q JOIN session s ON s.id = q.entry_session_id
        LEFT JOIN process p ON p.session_id = s.id AND p.id = s.process_id
      ${project === undefined ? sql`` : sql`WHERE q.id = ${project}`}
      ORDER BY s.created_at, s.id`

  const inboxWhere = (where: Statement.Fragment, order: Statement.Fragment = sql`m.id`) =>
    sql<InboxColumns>`SELECT m.id, m.session_id, m.sender_session_id, m.kind, m.content, m.status
      FROM inbox m WHERE ${where} ORDER BY ${order}`.pipe(Effect.flatMap((rows) => decodeInbox(rows.map(toInbox))))

  const briefs = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (ids.length === 0) return new Map<string, SessionBrief>() as ReadonlyMap<string, SessionBrief>
      const rows = yield* sql<{
        id: string
        task: string | null
        executionId: number | null
        outcome: string | null
        endedAt: number | null
        reply: string | null
      }>`SELECT s.id,
          (SELECT i.content FROM inbox i WHERE i.session_id = s.id AND i.kind = 'task'
            ORDER BY i.id LIMIT 1) AS task,
          t.id AS execution_id, t.outcome, t.ended_at, t.reply
        FROM session s LEFT JOIN execution t ON t.session_id = s.id AND t.id = (SELECT max(id) FROM execution WHERE session_id = s.id)
        WHERE ${sql.in("s.id", ids)}`
      const found = new Map<string, SessionBrief>()
      for (const row of rows) {
        const raw = row.executionId === null ? undefined : (row.outcome ?? "working")
        const status = raw !== undefined && MESSAGE_STATUSES.has(raw) ? (raw as MessageStatusName) : undefined
        found.set(row.id, {
          task: row.task === null ? null : unwrapped(row.task),
          latest:
            status === undefined
              ? null
              : { status, summary: row.reply?.trim().split("\n")[0] ?? "", endedAt: row.endedAt ?? null },
        })
      }
      return found as ReadonlyMap<string, SessionBrief>
    })

  const hadTerminal = (id: string) =>
    sql`SELECT 1 FROM process WHERE session_id = ${id} AND placed_at IS NOT NULL LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )

  const untakenTask = (id: string) =>
    sql<{ content: string }>`SELECT i.content FROM inbox i
      WHERE i.session_id = ${id} AND i.kind = 'task' AND i.execution_id IS NULL
      ORDER BY i.id LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.content))

  const queuedBy = (session: string, request: string) =>
    sql<{ id: number }>`SELECT id FROM inbox
      WHERE request = ${request} AND session_id = ${session}
      ORDER BY id LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.id))

  const spawnedBy = (project: string, request: string) =>
    sql<{
      id: string
      harness: string
      provider: string | null
      model: string | null
      runtime: string
      routing: string | null
    }>`SELECT s.id, p.harness, p.provider, p.model, p.runtime, p.routing FROM inbox i
        JOIN session s ON s.id = i.session_id
        JOIN process p ON p.session_id = s.id AND p.id = (SELECT min(id) FROM process WHERE session_id = s.id)
      WHERE i.kind = 'task' AND i.request = ${request} AND s.project_id = ${project}
      ORDER BY s.created_at, s.id LIMIT 1`.pipe(
      Effect.map((rows): SpawnedBefore | undefined => {
        const found = rows[0]
        if (found === undefined) return undefined
        return {
          id: found.id,
          harness: found.harness,
          provider: found.provider ?? undefined,
          model: found.model ?? undefined,
          runtime: found.runtime,
          routing: found.routing === null ? undefined : (JSON.parse(found.routing) as SpawnedBefore["routing"]),
        }
      }),
    )

  const outboxOf = (peer: string) =>
    sql<OutboxRow & { reportTo: string | null }>`SELECT o.id, o.session_id, o.kind, o.content, o.created_at,
        coalesce(o.recipient, s.origin_session) AS report_to
      FROM outbox o LEFT JOIN session s ON s.id = o.session_id WHERE o.peer_id = ${peer} ORDER BY o.seq`.pipe(
      Effect.map((rows) => rows.filter((row): row is OutboxRow => row.reportTo !== null)),
    )

  const rescheduleSource = (id: string) =>
    Effect.gen(function* () {
      const [head] = yield* sql<{
        parentSessionId: string | null
      }>`SELECT parent_session_id FROM session WHERE id = ${id}`
      if (head === undefined)
        return { working: "", delivered: "", parentSessionId: undefined, since: 0 } as RescheduleSource
      const executions = yield* sql<{
        id: number
        typed: string | null
        outcome: string | null
        startedAt: number
        taken: number
      }>`SELECT t.id, t.typed, t.outcome, t.started_at,
          EXISTS (SELECT 1 FROM inbox i WHERE i.session_id = t.session_id AND i.execution_id = t.id) AS taken
        FROM execution t WHERE session_id = ${id} ORDER BY id DESC`
      const execution = executions.find(
        (t, i) => (t.typed !== null || t.taken === 1) && executions.slice(0, i).every(retried),
      )
      let working = ""
      if (execution !== undefined) {
        const taken = yield* sql<{ content: string }>`SELECT content FROM inbox
          WHERE session_id = ${id} AND execution_id = ${execution.id} ORDER BY id`
        working = execution.typed ?? taken.map((row) => row.content).join("\n\n")
      }
      const [linked] = yield* sql<{ id: number | null }>`SELECT max(id) AS id FROM inbox
        WHERE session_id = ${id} AND execution_id IS NOT NULL`
      const rows = yield* sql<{ content: string; sender: string | null }>`SELECT content, sender_session_id AS sender
        FROM inbox WHERE session_id = ${id} AND status = 'delivered'
          AND id > ${linked?.id ?? 0}
        ORDER BY id`
      return {
        working,
        delivered: latestRun(rows),
        parentSessionId: head.parentSessionId ?? undefined,
        since: (execution ?? executions[0])?.startedAt ?? 0,
      } as RescheduleSource
    })

  return {
    rescheduleSource,
    briefs,
    hadTerminal,
    untakenTask,
    queuedBy,
    spawnedBy,
    outboxOf,
    sessionRows,
    entryRows,
    inboxWhere,
    hasPeerItem: (item: string) =>
      sql`SELECT 1 FROM inbox WHERE peer_item = ${item}`.pipe(Effect.map((rows) => rows.length > 0)),
    machines: sql<MachineRow>`SELECT name, target, vibestd_id, connected_at, created_at FROM machine ORDER BY name`,
  }
}
