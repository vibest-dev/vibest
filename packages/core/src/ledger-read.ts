import { decodeRow, type FactOf } from "@vibest/schema/event"
import { type AgentStatus, InboxRow } from "@vibest/schema/session"
import { Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/sql"

import type { MachineRow, OutboxRow } from "./db-remote.ts"
import {
  attemptsOf,
  CoordinatorRow,
  MESSAGE_STATUSES,
  type MessageStatusName,
  SessionRow,
  type Integration,
  type SessionBrief,
  type SpawnedBefore,
  toInbox,
  type TurnReport,
} from "./db-rows.ts"

export const LOCAL_MACHINE = "local"

export type RescheduleSource = {
  readonly working: string
  readonly delivered: string
  readonly parentSessionId: string | undefined
}

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

export type PeerRow = {
  readonly id: string
  readonly name: string
  readonly callsMe: string
  readonly connectedAt: number
}

export type SessionColumns = {
  readonly id: string
  readonly project: string
  readonly role: string
  readonly name: string
  readonly archive: number
  readonly createdAt: number
  readonly endedAt: number | null
  readonly activeAt: number | null
  readonly pId: number | null
  readonly harness: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly routing: string | null
  readonly resume: string | null
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
}

const integrationOf = (row: Pick<SessionColumns, "integrationVersion" | "integrationProtocol">) =>
  row.integrationVersion === null || row.integrationProtocol === null
    ? undefined
    : { version: row.integrationVersion, protocol: row.integrationProtocol }

const addressOf = (terminal: string | null) => JSON.stringify({ machine: LOCAL_MACHINE, id: terminal ?? "" })

export type Live = {
  readonly status: AgentStatus
  readonly integration: Integration | undefined
  readonly promptedAt: number | undefined
}

const NOT_LIVE: Live = { status: "unknown", integration: undefined, promptedAt: undefined }

export const sessionOf = (row: SessionColumns, live: Live = NOT_LIVE) => {
  const integration = live.integration ?? integrationOf(row)
  const attempts = attemptsOf(row.attempts)
  const open = row.tId !== null && row.tStatus === null
  const metadata = {
    ...(integration === undefined ? {} : { integration }),
    ...(row.pid === null ? {} : { pid: row.pid }),
    ...(row.readyAt === null ? {} : { ready: row.readyAt }),
    ...(row.routing === null ? {} : { routing: JSON.parse(row.routing) as unknown }),
    ...(row.archive === 1 ? { archive: true } : {}),
    ...(row.endedAt !== null && row.role !== "main" ? { archived: true, removed: true } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
  }
  return {
    id: row.id,
    projectId: row.project,
    agent: row.role,
    harnessId: row.harness ?? "",
    harnessSessionId: row.conversation ?? row.resume ?? null,
    runtime: row.runtime ?? "",
    address: addressOf(row.terminal),
    name: row.name,
    provider: row.provider,
    model: row.model,
    status: live.status,
    startedAt: row.placedAt,
    exitedAt: row.role === "main" ? row.endedAt : row.pEnded,
    turnState: row.tId === null ? "none" : (row.tStatus ?? "open"),
    turnPromptedAt: (open ? live.promptedAt : undefined) ?? row.tAt ?? 0,
    metadata: JSON.stringify(metadata),
    createdAt: row.createdAt,
    lastActive: row.activeAt ?? row.createdAt,
  }
}

export type CoordinatorColumns = SessionColumns & {
  readonly projectDirectory: string | null
  readonly ownDirectory: string
}

export const coordinatorOf = (
  row: CoordinatorColumns,
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
    projectId: row.project,
    harnessId: row.harness ?? "",
    harnessSessionId: row.conversation ?? row.resume ?? null,
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
export const decodeCoordinators = Schema.decodeUnknownEffect(Schema.Array(CoordinatorRow))

type InboxColumns = {
  readonly id: number
  readonly recipientSessionId: string | null
  readonly senderSessionId: string | null
  readonly kind: string
  readonly content: string
  readonly status: string
  readonly resultTurnId: number | null
  readonly turnStatus: string | null
  readonly failure: string | null
}

const inboxOf = (row: InboxColumns) =>
  toInbox({
    ...row,
    turnEnd:
      row.turnStatus === null
        ? null
        : JSON.stringify({
            status: row.turnStatus,
            ...(row.failure === null ? {} : { failure: { message: row.failure } }),
          }),
  })

export const ledgerReads = (sql: SqlClient.SqlClient) => {
  const sessionRows = (where: ReadonlyArray<Statement.Fragment>, filter?: Statement.Fragment) =>
    sql<SessionColumns>`SELECT * FROM (SELECT s.id, s.project_id AS project, s.role, s.name,
        s.archive_on_completion AS archive, s.created_at, s.ended_at, s.active_at,
        p.id AS p_id, p.harness, p.provider, p.model, p.routing, p.resume, p.runtime, p.terminal, p.pid,
        p.integration_version, p.integration_protocol, p.conversation, p.placed_at, p.ready_at,
        p.ended_at AS p_ended, t.id AS t_id, t.started_at AS t_at, t.status AS t_status,
        (SELECT json_group_array(json_object('harness', l.harness, 'provider', l.provider, 'at', l.ended_at))
          FROM (SELECT * FROM process WHERE session_id = s.id AND end_reason = 'limited' ORDER BY id) l) AS attempts
      FROM session s LEFT JOIN process p ON p.id = s.process_id LEFT JOIN turn t ON t.id = s.turn_id
      ${where.length === 0 ? sql`` : sql`WHERE ${sql.and(where)}`})
    ${filter === undefined ? sql`` : sql`WHERE ${filter}`} ORDER BY created_at, id`

  const sessions = sessionRows([]).pipe(Effect.flatMap((rows) => decodeSessions(rows.map((row) => sessionOf(row)))))

  const coordinatorRows = (project?: string) =>
    sql<CoordinatorColumns>`SELECT s.id, s.project_id AS project, s.created_at, s.directory AS own_directory,
        q.directory AS project_directory,
        p.id AS p_id, p.harness, p.provider, p.model, p.routing, p.resume, p.runtime, p.terminal, p.pid,
        p.integration_version, p.integration_protocol, p.conversation, p.ready_at, p.ended_at AS p_ended
      FROM project q JOIN session s ON s.id = q.entry_session_id LEFT JOIN process p ON p.id = s.process_id
      ${project === undefined ? sql`` : sql`WHERE q.id = ${project}`}
      ORDER BY s.created_at, s.id`

  const coordinators = coordinatorRows().pipe(
    Effect.flatMap((rows) => decodeCoordinators(rows.map((row) => coordinatorOf(row)))),
  )

  const inboxWhere = (where: Statement.Fragment, order: Statement.Fragment = sql`m.id`) =>
    sql<InboxColumns>`SELECT m.id, m.recipient_session_id, m.sender_session_id, m.kind, m.content, m.status,
        m.result_turn_id, t.status AS turn_status, t.failure
      FROM inbox m LEFT JOIN turn t ON t.id = m.result_turn_id WHERE ${where} ORDER BY ${order}`.pipe(
      Effect.flatMap((rows) => decodeInbox(rows.map(inboxOf))),
    )

  const inbox = Effect.gen(function* () {
    const rows = yield* sql<InboxColumns>`SELECT m.id, m.recipient_session_id, m.sender_session_id, m.kind,
        m.content, m.status, m.result_turn_id, t.status AS turn_status, t.failure
      FROM inbox m LEFT JOIN turn t ON t.id = m.result_turn_id WHERE m.kind != 'task' ORDER BY m.id`
    const decoded = yield* decodeInbox(rows.map(inboxOf))
    return rows.map((row, i) => ({
      row: decoded[i]!,
      id: row.id,
      recipient: row.recipientSessionId,
      sender: row.senderSessionId,
      resultTurn: row.resultTurnId,
    }))
  })

  const reportOf = (row: { seq: number; at: number; data: string; sessionId: string }) =>
    decodeRow({
      seq: row.seq,
      at: row.at,
      type: "turn.reported",
      project_id: "",
      session_id: row.sessionId,
      data: row.data,
    }).pipe(Effect.map((fact) => (fact as FactOf<"turn.reported">).data))

  const briefs = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (ids.length === 0) return new Map<string, SessionBrief>() as ReadonlyMap<string, SessionBrief>
      const rows = yield* sql<{
        id: string
        task: string | null
        turnId: number | null
        status: string | null
        endedAt: number | null
        answer: string | null
      }>`SELECT s.id,
          (SELECT i.content FROM inbox i WHERE i.recipient_session_id = s.id AND i.kind = 'task'
            ORDER BY i.id LIMIT 1) AS task,
          t.id AS turn_id, t.status, t.ended_at, t.answer
        FROM session s LEFT JOIN turn t ON t.id = s.turn_id
        WHERE ${sql.in("s.id", ids)}`
      const found = new Map<string, SessionBrief>()
      for (const row of rows) {
        const raw = row.turnId === null ? undefined : (row.status ?? "working")
        const status = raw !== undefined && MESSAGE_STATUSES.has(raw) ? (raw as MessageStatusName) : undefined
        found.set(row.id, {
          task: row.task ?? null,
          latest:
            status === undefined
              ? null
              : { status, summary: row.answer?.trim().split("\n")[0] ?? "", endedAt: row.endedAt ?? null },
        })
      }
      return found as ReadonlyMap<string, SessionBrief>
    })

  const latestReport = (id: string, fence: "ready" | "start") =>
    Effect.gen(function* () {
      const after =
        fence === "start"
          ? sql`(SELECT process_id FROM session WHERE id = ${id})`
          : sql`(SELECT p.ready_seq FROM session s JOIN process p ON p.id = s.process_id WHERE s.id = ${id})`
      const [row] = yield* sql<{ seq: number; at: number; data: string; consumed: number }>`SELECT r.seq, r.at, r.data,
          EXISTS (SELECT 1 FROM turn t WHERE t.report_seq = r.seq) AS consumed
        FROM event r WHERE r.session_id = ${id} AND r.type = 'turn.reported' AND r.seq > ${after}
        ORDER BY r.seq DESC LIMIT 1`
      if (row === undefined || row.consumed) return undefined
      const data = yield* reportOf({ ...row, sessionId: id })
      return {
        id: row.seq,
        at: row.at,
        harness: data.harness,
        text: data.text,
        error: data.error,
        conversationId: data.conversation,
        interrupted: data.interrupted === true,
      } satisfies TurnReport
    })

  const hadTerminal = (id: string) =>
    sql`SELECT 1 FROM process WHERE session_id = ${id} AND placed_at IS NOT NULL LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )

  const untakenTask = (id: string) =>
    sql<{ content: string }>`SELECT i.content FROM inbox i
      WHERE i.recipient_session_id = ${id} AND i.kind = 'task' AND i.seq = i.id
        AND NOT EXISTS (SELECT 1 FROM turn t WHERE t.session_id = ${id} AND t.status IS NOT NULL
          AND (t.typed IS NOT NULL OR EXISTS (SELECT 1 FROM inbox x WHERE x.turn_id = t.id)))
      ORDER BY i.id LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.content))

  const queuedBy = (session: string, request: string) =>
    sql<{ id: number }>`SELECT id FROM inbox
      WHERE request = ${request} AND coalesce(recipient_session_id, sender_session_id) = ${session}
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
        JOIN session s ON s.id = coalesce(i.recipient_session_id, i.sender_session_id)
        JOIN process p ON p.id = (SELECT min(id) FROM process WHERE session_id = s.id)
      WHERE i.kind = 'task' AND i.request = ${request} AND s.project_id = ${project}
      ORDER BY i.id LIMIT 1`.pipe(
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
        s.origin_report_to AS report_to
      FROM outbox o JOIN session s ON s.id = o.session_id WHERE o.peer_id = ${peer} ORDER BY o.seq`.pipe(
      Effect.map((rows) => rows.filter((row): row is OutboxRow => row.reportTo !== null)),
    )

  const rescheduleSource = (id: string) =>
    Effect.gen(function* () {
      const [head] = yield* sql<{
        parentSessionId: string | null
      }>`SELECT parent_session_id FROM session WHERE id = ${id}`
      if (head === undefined) return { working: "", delivered: "", parentSessionId: undefined } as RescheduleSource
      const [open] = yield* sql<{ id: number; typed: string | null }>`SELECT id, typed FROM turn
        WHERE session_id = ${id} AND status IS NULL`
      let working = ""
      if (open !== undefined) {
        const taken = yield* sql<{ content: string }>`SELECT content FROM inbox WHERE turn_id = ${open.id} ORDER BY id`
        working = open.typed ?? taken.map((row) => row.content).join("\n\n")
      }
      const [linked] = yield* sql<{ id: number | null }>`SELECT max(id) AS id FROM inbox
        WHERE recipient_session_id = ${id} AND turn_id IS NOT NULL`
      const rows = yield* sql<{ content: string; sender: string | null }>`SELECT content, sender_session_id AS sender
        FROM inbox WHERE recipient_session_id = ${id} AND status = 'delivered' AND kind IN ('task', 'send')
          AND id > ${linked?.id ?? 0}
        ORDER BY id`
      return {
        working,
        delivered: latestRun(rows),
        parentSessionId: head.parentSessionId ?? undefined,
      } as RescheduleSource
    })

  return {
    sessions,
    coordinators,
    rescheduleSource,
    inbox,
    briefs,
    latestReport,
    hadTerminal,
    untakenTask,
    queuedBy,
    spawnedBy,
    outboxOf,
    sessionRows,
    coordinatorRows,
    inboxWhere,
    hasPeerItem: (item: string) =>
      sql`SELECT 1 FROM inbox WHERE peer_item = ${item}`.pipe(Effect.map((rows) => rows.length > 0)),
    machines: sql<MachineRow>`SELECT name, target, vibestd_id, connected_at, created_at FROM machine ORDER BY name`,
    peers: sql<PeerRow>`SELECT id, name, calls_me, connected_at FROM peer ORDER BY id`,
  }
}
