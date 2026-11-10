import { InboxRow } from "@vibest/schema/session"
import { Effect, Option, Schema } from "effect"
import type { SqlClient, Statement } from "effect/sql"

import type { MachineRow, OutboxRow } from "../db-remote.ts"
import {
  CoordinatorRow,
  MESSAGE_STATUSES,
  type MessageStatusName,
  SessionRow,
  type SessionBrief,
  type SpawnedBefore,
  type TurnReport,
} from "../db-rows.ts"
import type { HarnessId } from "../harness.ts"
import { latestRun, type PeerRow, type RescheduleSource } from "../ledger-read.ts"
import type { Routing } from "../plugins.ts"
import type { Probes, Reader } from "./referee.ts"

export type V1Project = {
  readonly id: string
  readonly directory: string | null
  readonly entrySessionId: string | null
}
export type V1Repository = { readonly projectId: string; readonly path: string; readonly remoteUrl: string | null }
export type V1Session = {
  readonly id: string
  readonly projectId: string
  readonly parentSessionId: string | null
  readonly reportToSessionId: string | null
  readonly role: string
  readonly name: string
  readonly machine: string
  readonly directory: string
  readonly archiveOnCompletion: number
  readonly createdAt: number
  readonly endedAt: number | null
}
export type V1Inbox = {
  readonly id: number
  readonly recipientSessionId: string | null
  readonly kind: string
  readonly senderSessionId: string | null
  readonly content: string
  readonly resultEventId: number | null
  readonly status: string
}
export type V1Event = {
  readonly id: number
  readonly at: number
  readonly sessionId: string
  readonly type: string
  readonly processId: number | null
  readonly turnId: number | null
  readonly inboxId: number | null
  readonly data: string
}
export type V1Outbox = {
  readonly id: string
  readonly peerId: string
  readonly sessionId: string
  readonly kind: string
  readonly content: string
  readonly createdAt: number
}

export type Snapshot = {
  readonly projects: ReadonlyArray<V1Project>
  readonly repositories: ReadonlyArray<V1Repository>
  readonly sessions: ReadonlyArray<V1Session>
  readonly inbox: ReadonlyArray<V1Inbox>
  readonly events: ReadonlyArray<V1Event>
  readonly machines: ReadonlyArray<MachineRow>
  readonly peers: ReadonlyArray<PeerRow>
  readonly outbox: ReadonlyArray<V1Outbox>
}

const REMOTE = ["machine", "peer", "outbox"] as const
const TO_SESSION = `('task', 'send')`

export const readSnapshot = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tables = new Set(
      (yield* sql<{ name: string }>`SELECT name FROM sqlite_schema WHERE type = 'table'`).map((row) => row.name),
    )
    const remote = (table: (typeof REMOTE)[number], query: Statement.Statement<object>) =>
      tables.has(table) ? query : Effect.succeed([])
    return {
      projects: yield* sql<V1Project>`SELECT id, directory, entry_session_id FROM project ORDER BY rowid`,
      repositories:
        yield* sql<V1Repository>`SELECT project_id, path, remote_url FROM project_repository ORDER BY rowid`,
      sessions: yield* sql<V1Session>`SELECT id, project_id, parent_session_id, report_to_session_id, role, name,
          machine, directory, archive_on_completion, created_at, ended_at FROM session ORDER BY rowid`,
      inbox: yield* sql<V1Inbox>`SELECT id, recipient_session_id, kind, sender_session_id, content, result_event_id,
          status FROM inbox ORDER BY id`,
      events: yield* sql<V1Event>`SELECT id, at, session_id, type, process_id, turn_id, inbox_id, data
          FROM event ORDER BY id`,
      machines: (yield* remote(
        "machine",
        sql`SELECT name, target, vibestd_id, connected_at, created_at FROM machine ORDER BY created_at, name`,
      )) as ReadonlyArray<MachineRow>,
      peers: (yield* remote(
        "peer",
        sql`SELECT id, name, calls_me, connected_at FROM peer ORDER BY rowid`,
      )) as ReadonlyArray<PeerRow>,
      outbox: (yield* remote(
        "outbox",
        sql`SELECT id, peer_id, session_id, kind, content, created_at FROM outbox ORDER BY created_at, rowid`,
      )) as ReadonlyArray<V1Outbox>,
    } satisfies Snapshot
  })

const requestOf = (data: string) => {
  const request = (JSON.parse(data) as { request?: unknown }).request
  return typeof request === "string" ? request : undefined
}

export const probesOf = (snapshot: Snapshot): Probes => {
  const inbox = new Map(snapshot.inbox.map((row) => [row.id, row]))
  const project = new Map(snapshot.sessions.map((row) => [row.id, row.projectId]))
  const requests: Array<readonly [string, string]> = []
  const spawns: Array<readonly [string, string]> = []
  const peerItems: Array<string> = []
  for (const event of snapshot.events) {
    if (event.type !== "inbox.queued") continue
    const request = requestOf(event.data)
    if (request === undefined) continue
    if (request.startsWith("peer:")) {
      peerItems.push(request.slice("peer:".length))
      continue
    }
    requests.push([event.sessionId, request])
    if (inbox.get(event.inboxId ?? -1)?.kind === "task") spawns.push([project.get(event.sessionId)!, request])
  }
  return {
    sessions: snapshot.sessions.map((row) => row.id),
    requests,
    spawns,
    peers: [...new Set([...snapshot.peers.map((row) => row.id), ...snapshot.outbox.map((row) => row.peerId)])],
    peerItems: [...new Set(peerItems)],
  }
}

type ProcessStart = {
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

type Integration = { readonly version: string; readonly protocol: number }

type SessionSql = {
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

type Current = {
  readonly id: number
  readonly start: ProcessStart
  readonly at: number
  readonly ended: number | null
}

const currentOf = (row: SessionSql): Current | undefined =>
  row.pId === null || row.pData === null || row.pAt === null
    ? undefined
    : { id: row.pId, start: JSON.parse(row.pData) as ProcessStart, at: row.pAt, ended: row.pEnded }

const attemptsOf = (raw: string | null) => {
  const seen: Array<{ harness: string; provider?: string; outcome: "limited"; at: number }> = []
  for (const a of JSON.parse(raw ?? "[]") as ReadonlyArray<{ harness: string; provider: string | null; at: number }>) {
    const provider = a.provider ?? undefined
    if (seen.some((s) => s.harness === a.harness && s.provider === provider)) continue
    seen.push({ harness: a.harness, ...(provider === undefined ? {} : { provider }), outcome: "limited", at: a.at })
  }
  return seen
}

const fromColumns = (row: SessionSql, status: "unknown", integration: Integration | undefined) => {
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

type TurnEnd = {
  readonly status: string
  readonly output?: string
  readonly report?: number
  readonly failure?: { readonly message: string }
}

const summaryIn = (content: string) => {
  const found = /<summary>([\s\S]*?)<\/summary>/.exec(content)
  return found === null
    ? undefined
    : found[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
}

const resultDetails = (content: string, end: TurnEnd | undefined) => {
  const error = end?.failure?.message
  const summary = summaryIn(content)
  return {
    status: end?.status === "completed" && error === undefined ? "completed" : "failed",
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
  }
}

type InboxSql = {
  readonly id: number
  readonly recipientSessionId: string | null
  readonly kind: string
  readonly senderSessionId: string | null
  readonly content: string
  readonly status: string
  readonly turnEnd: string | null
}

const toInbox = (row: InboxSql) => {
  const kind = row.kind
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

type BriefRow = {
  readonly id: string
  readonly task: string | null
  readonly turnId: number | null
  readonly endData: string | null
  readonly endedAt: number | null
  readonly resultContent: string | null
  readonly answer: string | null
}

const PeerStart = Schema.Struct({
  peer: Schema.String,
  project: Schema.String,
  parent: Schema.optional(Schema.String),
  reportTo: Schema.optional(Schema.String),
})

const decodeStart = Schema.decodeUnknownOption(Schema.fromJsonString(PeerStart))

export const peerStartOf = (data: string | null) => {
  if (data === null) return undefined
  const start = decodeStart(data)
  return Option.isSome(start) ? start.value : undefined
}

const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow))
const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxRow))
const decodeCoordinators = Schema.decodeUnknownEffect(Schema.Array(CoordinatorRow))

export type SeqOf = { readonly event: (id: number) => number; readonly inbox: (id: number) => number }

export const v1Reader = (sql: SqlClient.SqlClient, snapshot: Snapshot, seqOf: SeqOf): Reader => {
  const currentStart = (session: Statement.Fragment) => sql`(SELECT cs.id FROM event cs
      WHERE cs.session_id = ${session} AND cs.type = 'process.start'
      ORDER BY (json_extract(cs.data, '$.terminal') = '' AND EXISTS (SELECT 1 FROM event cf WHERE cf.process_id = cs.id
        AND cf.type = 'process.end' AND json_extract(cf.data, '$.reason') = 'launch_failed')), cs.id DESC LIMIT 1)`

  const SESSION_COLUMNS = sql`a.id, a.project_id AS project, a.role, a.name, a.machine,
      a.archive_on_completion AS archive, a.created_at, a.ended_at,
      p.id AS p_id, p.at AS p_at, p.data AS p_data,
      (SELECT e.at FROM event e WHERE e.process_id = p.id AND e.type = 'process.end') AS p_ended,
      (SELECT json_extract(e.data, '$.pid') FROM event e WHERE e.process_id = p.id AND e.type = 'process.ready'
        AND json_extract(e.data, '$.pid') IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS pid,
      (SELECT e.at FROM event e WHERE e.process_id = p.id AND e.type = 'process.ready'
        AND json_extract(e.data, '$.pidOnly') IS NULL ORDER BY e.id DESC LIMIT 1) AS ready_at,
      (SELECT json_extract(e.data, '$.integration') FROM event e WHERE e.process_id = p.id AND e.type = 'process.ready'
        AND json_extract(e.data, '$.integration') IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS integration,
      (SELECT json_extract(e.data, '$.conversation') FROM event e WHERE e.process_id = p.id
        AND e.type IN ('process.ready', 'process.conversation') AND json_extract(e.data, '$.conversation') IS NOT NULL
        ORDER BY e.id DESC LIMIT 1) AS conversation,
      t.id AS t_id, t.at AS t_at,
      (SELECT json_extract(e.data, '$.status') FROM event e WHERE e.turn_id = t.id AND e.type = 'turn.end') AS t_end,
      (SELECT max(e.at) FROM event e WHERE e.session_id = a.id) AS last_at,
      (SELECT json_group_array(json_object('harness', json_extract(ps.data, '$.harness'),
          'provider', json_extract(ps.data, '$.provider'), 'at', pe.at))
        FROM (SELECT * FROM event WHERE session_id = a.id AND type = 'process.end'
          AND json_extract(data, '$.reason') = 'limited' ORDER BY id) pe
        JOIN event ps ON ps.id = pe.process_id) AS attempts
    FROM session a
    LEFT JOIN event p ON p.id = ${currentStart(sql`a.id`)}
    LEFT JOIN event t ON t.id = (SELECT max(id) FROM event WHERE session_id = a.id AND type = 'turn.start')`

  const selectRaw = (where: ReadonlyArray<Statement.Fragment>) =>
    sql<SessionSql>`SELECT * FROM (SELECT ${SESSION_COLUMNS} ${where.length === 0 ? sql`` : sql`WHERE ${sql.and(where)}`}) ORDER BY created_at, id`

  const placed = (current: Current | undefined) =>
    current !== undefined && current.ended === null && current.start.terminal !== ""

  const findCoordinators = selectRaw([sql`a.id IN (SELECT entry_session_id FROM project)`]).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const current = currentOf(row)
          const start = current?.start
          const [project] = yield* sql<{
            directory: string | null
          }>`SELECT directory FROM project WHERE id = ${row.project}`
          const [own] = yield* sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${row.id}`
          const integration = row.integration !== null ? (JSON.parse(row.integration) as Integration) : undefined
          const pid = row.pid ?? start?.pid
          const here = placed(current)
          const directory = project?.directory || own?.directory
          return {
            id: row.id,
            projectId: row.project,
            harnessId: start?.harness ?? "",
            harnessSessionId: row.conversation ?? start?.resume ?? null,
            runtime: here ? start!.runtime : null,
            address: here ? JSON.stringify({ machine: start!.machine, id: start!.terminal }) : null,
            ...(directory ? { projectDirectory: directory } : {}),
            createdAt: row.createdAt,
            provider: start?.provider ?? null,
            model: start?.model ?? null,
            ...(start?.routing === undefined ? {} : { routing: start.routing }),
            ...(integration === undefined ? {} : { integration }),
            ...(pid === null || pid === undefined ? {} : { pid }),
            ...(row.readyAt === null ? {} : { ready: row.readyAt }),
          }
        }),
      ),
    ),
    Effect.flatMap(decodeCoordinators),
  )

  const turnOfEnd = new Map(
    snapshot.events.filter((e) => e.type === "turn.end" && e.turnId !== null).map((e) => [e.id, e.turnId!]),
  )

  const inbox = Effect.gen(function* () {
    const all = yield* sql<InboxSql & { resultEventId: number | null }>`SELECT m.id, m.recipient_session_id, m.kind,
        m.sender_session_id, m.content, m.status, m.result_event_id, te.data AS turn_end
      FROM inbox m LEFT JOIN event te ON te.id = m.result_event_id ORDER BY m.id`
    const rows = all.filter((row) => row.kind !== "task")
    const decoded = yield* decodeInbox(rows.map(toInbox))
    return rows.map((row, i) => ({
      row: { ...decoded[i]!, id: seqOf.inbox(row.id) },
      id: seqOf.inbox(row.id),
      recipient: row.recipientSessionId,
      sender: row.senderSessionId,
      resultTurn: row.resultEventId === null ? null : seqOf.event(turnOfEnd.get(row.resultEventId) ?? -1),
    }))
  })

  const sessionBriefs = (ids: ReadonlyArray<string>) =>
    (ids.length === 0
      ? Effect.succeed([] as ReadonlyArray<BriefRow>)
      : sql<BriefRow>`SELECT a.id,
          (SELECT i.content FROM inbox i WHERE i.recipient_session_id = a.id AND i.kind = 'task'
            ORDER BY i.id LIMIT 1) AS task,
          t.id AS turn_id,
          te.data AS end_data,
          te.at AS ended_at,
          (SELECT i.content FROM inbox i WHERE i.result_event_id = te.id ORDER BY i.id LIMIT 1) AS result_content,
          coalesce(json_extract(tr.data, '$.text'), json_extract(te.data, '$.output')) AS answer
        FROM session a
        LEFT JOIN event t ON t.id = (SELECT max(id) FROM event WHERE session_id = a.id AND type = 'turn.start')
        LEFT JOIN event te ON te.turn_id = t.id AND te.type = 'turn.end'
        LEFT JOIN event tr ON tr.id = json_extract(te.data, '$.report') AND tr.type = 'turn.reported'
        WHERE ${sql.in("a.id", ids)}`
    ).pipe(
      Effect.map((rows) => {
        const briefs = new Map<string, SessionBrief>()
        for (const row of rows) {
          const end = row.endData === null ? undefined : (JSON.parse(row.endData) as TurnEnd)
          const raw = row.turnId === null ? undefined : (end?.status ?? "working")
          const status = raw !== undefined && MESSAGE_STATUSES.has(raw) ? (raw as MessageStatusName) : undefined
          const summary =
            (row.resultContent === null ? undefined : summaryIn(row.resultContent)) ??
            (row.answer === null ? undefined : row.answer.split("\n")[0]) ??
            ""
          briefs.set(row.id, {
            task: row.task ?? null,
            latest: status === undefined ? null : { status, summary, endedAt: row.endedAt ?? null },
          })
        }
        return briefs as ReadonlyMap<string, SessionBrief>
      }),
    )

  const latestReport = (id: string, fence: "ready" | "start") =>
    sql<{ id: number; at: number; data: string; consumed: number }>`SELECT r.id, r.at, r.data,
      EXISTS (SELECT 1 FROM event te WHERE te.session_id = ${id} AND te.type = 'turn.end'
        AND json_extract(te.data, '$.report') = r.id) AS consumed
      FROM event r WHERE r.session_id = ${id} AND r.type = 'turn.reported' AND r.id > ${
        fence === "start"
          ? currentStart(sql`${id}`)
          : sql`(SELECT min(e.id) FROM event e WHERE e.process_id = ${currentStart(sql`${id}`)}
              AND e.type = 'process.ready' AND json_extract(e.data, '$.pidOnly') IS NULL)`
      }
      ORDER BY r.id DESC LIMIT 1`.pipe(
      Effect.map((rows) => {
        const row = rows[0]
        if (row === undefined || row.consumed) return undefined
        const data = JSON.parse(row.data) as {
          harness?: unknown
          text?: unknown
          error?: unknown
          conversation?: unknown
          interrupted?: unknown
        }
        if (typeof data.harness !== "string") return undefined
        return {
          id: seqOf.event(row.id),
          at: row.at,
          harness: data.harness as HarnessId,
          text: typeof data.text === "string" ? data.text : "",
          error: typeof data.error === "string" && data.error !== "" ? data.error : undefined,
          conversationId: typeof data.conversation === "string" ? data.conversation : undefined,
          interrupted: data.interrupted === true,
        } satisfies TurnReport
      }),
    )

  const queuedBy = (sessionId: string, request: string) =>
    sql<{ id: number }>`SELECT inbox_id AS id FROM event WHERE session_id = ${sessionId} AND type = 'inbox.queued'
        AND json_extract(data, '$.request') = ${request} LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : seqOf.inbox(rows[0].id))),
    )

  const spawnedBy = (project: string, request: string) =>
    sql<{ id: string; data: string }>`SELECT s.id, p.data FROM session s
        JOIN event q ON q.session_id = s.id AND q.type = 'inbox.queued'
        JOIN inbox i ON i.id = q.inbox_id AND i.kind = 'task'
        JOIN event p ON p.id = (SELECT min(id) FROM event WHERE session_id = s.id AND type = 'process.start')
      WHERE s.project_id = ${project} AND json_extract(q.data, '$.request') = ${request} LIMIT 1`.pipe(
      Effect.map((rows): SpawnedBefore | undefined => {
        const found = rows[0]
        if (found === undefined) return undefined
        const start = JSON.parse(found.data) as ProcessStart
        return {
          id: found.id,
          harness: start.harness,
          provider: start.provider,
          model: start.model,
          runtime: start.runtime,
          routing: start.routing as typeof Routing.Type | undefined,
        }
      }),
    )

  const untakenTask = (id: string) =>
    sql<{ content: string }>`SELECT i.content FROM inbox i WHERE i.recipient_session_id = ${id} AND i.kind = 'task'
        AND NOT EXISTS (SELECT 1 FROM event e WHERE e.inbox_id = i.id AND e.type = 'inbox.status')
        AND NOT EXISTS (SELECT 1 FROM event te JOIN event t ON t.id = te.turn_id
          WHERE te.session_id = ${id} AND te.type = 'turn.end' AND (json_extract(t.data, '$.typed') IS NOT NULL
            OR EXISTS (SELECT 1 FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status')))
      LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.content))

  const openTurn = (sessionId: string) =>
    sql<{ id: number }>`SELECT t.id FROM event t WHERE t.id = (SELECT max(id) FROM event WHERE session_id = ${sessionId}
        AND type = 'turn.start') AND NOT EXISTS (SELECT 1 FROM event e WHERE e.turn_id = t.id AND e.type = 'turn.end')`.pipe(
      Effect.map((rows) => rows[0]?.id),
    )

  const rescheduleSource = (id: string) =>
    Effect.gen(function* () {
      const [head] = yield* sql<{
        parentSessionId: string | null
      }>`SELECT parent_session_id FROM session WHERE id = ${id}`
      if (head === undefined) return { working: "", delivered: "", parentSessionId: undefined } as RescheduleSource
      const open = yield* openTurn(id)
      let working = ""
      if (open !== undefined) {
        const [t] = yield* sql<{
          typed: string | null
        }>`SELECT json_extract(data, '$.typed') AS typed FROM event WHERE id = ${open}`
        const rows = yield* sql<{
          content: string
        }>`SELECT i.content FROM inbox i WHERE i.id IN (SELECT e.inbox_id FROM event e
            WHERE e.type = 'inbox.status' AND json_extract(e.data, '$.to') = 'delivered' AND e.turn_id = ${open})
          ORDER BY i.id`
        working = t?.typed ?? rows.map((r) => r.content).join("\n\n")
      }
      const [linked] = yield* sql<{ id: number | null }>`SELECT max(e.inbox_id) AS id FROM event e
        WHERE e.session_id = ${id} AND e.type = 'inbox.status' AND e.turn_id IS NOT NULL`
      const rows = yield* sql<{ content: string; sender: string | null }>`SELECT content, sender_session_id AS sender
        FROM inbox WHERE recipient_session_id = ${id} AND status = 'delivered' AND kind IN ${sql.literal(TO_SESSION)}
          AND id > ${linked?.id ?? 0}
        ORDER BY id`
      return {
        working,
        delivered: latestRun(rows),
        parentSessionId: head.parentSessionId ?? undefined,
      } as RescheduleSource
    })

  const hadTerminal = (id: string) =>
    sql<{ one: number }>`SELECT 1 AS one FROM event WHERE session_id = ${id} AND type = 'process.start'
      AND json_extract(data, '$.terminal') != '' LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0))

  const outboxOf = (peer: string) =>
    snapshot.outbox.length === 0
      ? Effect.succeed([] as ReadonlyArray<OutboxRow>)
      : sql<Omit<OutboxRow, "reportTo"> & { readonly start: string | null }>`SELECT o.id, o.session_id, o.kind,
            o.content, o.created_at,
            (SELECT pe.data FROM event pe WHERE pe.session_id = o.session_id AND pe.type = 'peer.start' LIMIT 1) AS start
          FROM outbox o WHERE o.peer_id = ${peer} ORDER BY o.created_at, o.rowid`.pipe(
          Effect.map((rows) =>
            rows.flatMap(({ start, ...row }): Array<OutboxRow> => {
              const origin = peerStartOf(start)
              return origin?.reportTo === undefined ? [] : [{ ...row, reportTo: origin.reportTo }]
            }),
          ),
        )

  const origins = new Map(
    snapshot.events
      .filter((e) => e.type === "peer.start")
      .reverse()
      .map((e) => [e.sessionId, peerStartOf(e.data)]),
  )

  return {
    rescheduleSource,
    sessions: selectRaw([]).pipe(
      Effect.flatMap((rows) => decodeSessions(rows.map((row) => fromColumns(row, "unknown", undefined)))),
    ),
    sessionColumns: Effect.succeed(
      snapshot.sessions.map((s) => {
        const origin = origins.get(s.id)
        return {
          id: s.id,
          projectId: s.projectId,
          parentSessionId: s.parentSessionId,
          reportToSessionId: s.reportToSessionId,
          role: s.role,
          name: s.name,
          directory: s.directory,
          archiveOnCompletion: s.archiveOnCompletion,
          createdAt: s.createdAt,
          endedAt: s.endedAt,
          originPeer: origin?.peer ?? null,
          originProject: origin?.project ?? null,
          originParent: origin?.parent ?? null,
          originReportTo: origin?.reportTo ?? null,
        }
      }),
    ),
    projects: Effect.succeed(
      snapshot.projects.map((p) => ({
        id: p.id,
        directory: p.directory,
        entrySessionId: p.entrySessionId,
        repositories: snapshot.repositories
          .filter((r) => r.projectId === p.id)
          .map((r) => ({ path: r.path, remoteUrl: r.remoteUrl }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      })),
    ),
    coordinators: findCoordinators,
    inbox,
    briefs: sessionBriefs,
    latestReport,
    hadTerminal,
    untakenTask,
    queuedBy,
    spawnedBy,
    machines: Effect.succeed(snapshot.machines),
    peers: Effect.succeed(snapshot.peers),
    outboxOf,
    hasPeerItem: () => Effect.succeed(true),
  }
}
