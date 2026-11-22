import { type AgentStatus, InboxRow } from "@vibest/schema/session"
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/sql"

import { unwrapped } from "../replies.ts"
import {
  isMessageStatus,
  decodeRoutingJson,
  SessionRow,
  type Integration,
  type SessionBrief,
  type SpawnedBefore,
  type FromSql,
  fromOf,
  toInbox,
  type InboxSql,
} from "./db-rows.ts"
import type { MachineRow, OutboxRow } from "./remote.ts"

export const LOCAL_MACHINE = "local"

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
  readonly parent: string | null
  readonly entry: number
  readonly pEndReason: string | null
  readonly oId: number | null
  readonly oProcess: number | null
  readonly oBooked: number | null
  readonly oAt: number | null
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

export type Live = {
  readonly status: AgentStatus
  readonly integration: Integration | undefined
}

const decodeUnknownJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))

const NOT_LIVE: Live = { status: "unknown", integration: undefined }

const processOf = (row: SessionColumns, integration: Integration | undefined) =>
  row.pId === null
    ? null
    : {
        id: row.pId,
        harness: row.harness ?? "",
        provider: row.provider,
        model: row.model,
        routing: row.routing === null ? null : decodeUnknownJson(row.routing),
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
  row.oId === null ? null : { id: row.oId, process: row.oProcess, bookedAt: row.oBooked ?? 0, startedAt: row.oAt }

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
            : { message: row.lFailure, ...(row.lFailureKind !== null && { kind: row.lFailureKind }) },
      }

export const sessionOf = (row: SessionColumns, live: Live = NOT_LIVE) => ({
  id: row.id,
  projectId: row.project,
  agent: row.agent,
  name: row.name,
  status: live.status,
  createdAt: row.createdAt,
  lastActive: row.activeAt ?? row.createdAt,
  endedAt: row.endedAt,
  parentId: row.parent,
  entry: row.entry === 1,
  process: processOf(row, live.integration ?? integrationOf(row)),
  openExecution: openExecutionOf(row),
  lastExecution: lastExecutionOf(row),
})

export const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow))
const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxRow))

type InboxColumns = InboxSql

export const ledgerReads = (sql: SqlClient.SqlClient) => {
  const sessionRows = (where: ReadonlyArray<Statement.Fragment>, filter?: Statement.Fragment) =>
    sql<SessionColumns>`SELECT * FROM (SELECT s.id, s.project_id AS project, s.agent, s.name,
        s.created_at, s.ended_at, s.active_at, s.parent_session_id AS parent,
        EXISTS (SELECT 1 FROM project q WHERE q.entry_session_id = s.id) AS entry,
        p.id AS p_id, p.harness, p.provider, p.model, p.routing, p.runtime, p.terminal, p.pid,
        p.integration_version, p.integration_protocol, p.conversation, p.placed_at, p.ready_at,
        p.ended_at AS p_ended, p.end_reason AS p_end_reason,
        o.id AS o_id, o.process_id AS o_process, o.booked_at AS o_booked, o.started_at AS o_at,
        l.id AS l_id, l.process_id AS l_process, l.outcome AS l_outcome, l.started_at AS l_at,
        l.ended_at AS l_ended, l.reply AS l_reply, l.failure AS l_failure, l.failure_kind AS l_failure_kind
      FROM session s LEFT JOIN process p ON p.session_id = s.id AND p.id = s.process_id
        LEFT JOIN execution o ON o.session_id = s.id AND o.owner = 1
        LEFT JOIN execution l ON l.session_id = s.id AND l.id = (SELECT id FROM execution
          WHERE session_id = s.id AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1)
      ${where.length === 0 ? sql`` : sql`WHERE ${sql.and(where)}`})
    ${filter === undefined ? sql`` : sql`WHERE ${filter}`} ORDER BY created_at, id`

  const inboxWhere = (where: Statement.Fragment, order: Statement.Fragment = sql`m.id`) =>
    sql<InboxColumns>`SELECT m.id, m.session_id, m.sender_type, m.sender_session_id, m.sender_agent, m.sender_title,
        m.sender_machine, m.sender_plugin, m.kind, m.content, m.status
      FROM inbox m WHERE ${where} ORDER BY ${order}`.pipe(Effect.flatMap((rows) => decodeInbox(rows.map(toInbox))))

  const briefs = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (ids.length === 0) return new Map<string, SessionBrief>()

      const rows = yield* sql<{
        id: string
        task: string | null
        executionId: number | null
        outcome: string | null
        endedAt: number | null
        reply: string | null
        owner: number | null
      }>`SELECT s.id,
          (SELECT i.content FROM inbox i WHERE i.session_id = s.id AND i.kind = 'task'
            ORDER BY i.id LIMIT 1) AS task,
          t.id AS execution_id, t.outcome, t.ended_at, t.reply, t.owner AS owner
        FROM session s LEFT JOIN execution t ON t.session_id = s.id AND t.id = (SELECT max(id) FROM execution WHERE session_id = s.id)
        WHERE ${sql.in("s.id", ids)}`

      const found = new Map<string, SessionBrief>()

      for (const row of rows) {
        const raw =
          row.executionId === null
            ? undefined
            : row.owner === 1 && row.outcome === null
              ? "working"
              : (row.outcome ?? undefined)

        const status = raw !== undefined && isMessageStatus(raw) ? raw : undefined
        found.set(row.id, {
          task: row.task === null ? null : unwrapped(row.task),
          latest:
            status === undefined
              ? null
              : { status, summary: row.reply?.trim().split("\n")[0] ?? "", endedAt: row.endedAt ?? null },
        })
      }

      return found
    })

  const hadTerminal = (id: string) =>
    sql`SELECT 1 FROM process WHERE session_id = ${id} AND placed_at IS NOT NULL LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )

  const untakenTask = (id: string) =>
    sql<{ content: string }>`SELECT i.content FROM inbox i
      WHERE i.session_id = ${id} AND i.kind = 'task' AND i.execution_id IS NULL
      ORDER BY i.id LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.content))

  const spawnedBy = (project: string, request: string) =>
    sql<{
      id: string
      harness: string | null
      provider: string | null
      model: string | null
      runtime: string | null
      routing: string | null
    }>`SELECT s.id, p.harness, p.provider, p.model, p.runtime, p.routing FROM inbox i
        JOIN session s ON s.id = i.session_id
        LEFT JOIN process p ON p.session_id = s.id AND p.id = (SELECT min(id) FROM process WHERE session_id = s.id)
      WHERE i.kind = 'task' AND i.request = ${request} AND s.project_id = ${project}
      ORDER BY s.created_at, s.id LIMIT 1`.pipe(
      Effect.map((rows): SpawnedBefore | undefined => {
        const found = rows[0]

        if (found === undefined) return undefined

        return {
          id: found.id,
          harness: found.harness ?? "",
          provider: found.provider ?? undefined,
          model: found.model ?? undefined,
          runtime: found.runtime ?? "",
          routing: found.routing === null ? undefined : decodeRoutingJson(found.routing),
        }
      }),
    )

  const outboxOf = (peer: string, after: number, limit: number) =>
    sql<Omit<OutboxRow, "from"> & FromSql>`SELECT o.id, o.seq, o.session_id, o.kind, o.content,
        o.from_session, o.from_agent, o.from_title, o.from_machine, o.created_at,
        coalesce(o.recipient, s.origin_session) AS report_to
      FROM outbox o LEFT JOIN session s ON s.id = o.session_id
      WHERE o.peer_id = ${peer} AND o.acked_at IS NULL AND o.seq > ${after} AND coalesce(o.recipient, s.origin_session) IS NOT NULL
      ORDER BY o.seq LIMIT ${limit}`.pipe(
      Effect.map((rows) =>
        rows.map(({ fromSession, fromAgent, fromTitle, fromMachine, ...row }): OutboxRow => ({
          ...row,
          from: fromOf({ fromSession, fromAgent, fromTitle, fromMachine }),
        })),
      ),
    )

  return {
    briefs,
    hadTerminal,
    untakenTask,
    spawnedBy,
    outboxOf,
    sessionRows,
    inboxWhere,
    hasPeerItem: (item: string) =>
      sql`SELECT 1 FROM inbox WHERE peer_item = ${item}`.pipe(Effect.map((rows) => rows.length > 0)),
    machines: sql<MachineRow>`SELECT name, target, vibestd_id, connected_at, created_at FROM machine ORDER BY name`,
  }
}
