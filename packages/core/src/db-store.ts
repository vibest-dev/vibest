import { newId } from "@vibest/schema/id"
import { AgentStatus, InboxRow, InboxStatus, RuntimeAddress } from "@vibest/schema/session"
import { Clock, Context, Effect, Schema } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { Bus, type EngineEvent, type LiveEvent, type StoredEvent, type StoredType } from "./bus.ts"
import {
  encodeAddress,
  SessionRow,
  CoordinatorRow,
  currentOf,
  fromColumns,
  decodeSessions,
  storedStatus,
  failureOf,
  toInbox,
  roundStatus,
  type EndReason,
  type SessionPatch,
  type NewInboxRow,
  type RepositoryRow,
  type ProcessStart,
  type Integration,
  type SessionSql,
  type Current,
  type InboxSql,
  type TurnEnd,
} from "./db-rows.ts"
import { Routing } from "./plugins.ts"

export const TO_SESSION = `('task', 'send')`

const TxBuffer = Context.Reference<
  { readonly events: Array<EngineEvent>; readonly fiberId: number; closed: boolean } | undefined
>("vibest/TxBuffer", { defaultValue: () => undefined })

export const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const bus = yield* Bus
  const currentStart = (session: Statement.Fragment) => sql`(SELECT cs.id FROM event cs
      WHERE cs.session_id = ${session} AND cs.type = 'process.start'
      ORDER BY (json_extract(cs.data, '$.terminal') = '' AND EXISTS (SELECT 1 FROM event cf WHERE cf.process_id = cs.id
        AND cf.type = 'process.end' AND json_extract(cf.data, '$.reason') = 'launch_failed')), cs.id DESC LIMIT 1)`
  const now = Clock.currentTimeMillis
  const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxRow))
  const decodeCoordinators = Schema.decodeUnknownEffect(Schema.Array(CoordinatorRow))
  const statuses = new Map<string, AgentStatus>()
  const integrations = new Map<string, Integration>()
  const prompted = new Map<number, number>()
  const moving = new Set<string>()
  const remember = (row: Pick<SessionRow, "id" | "status" | "metadata">) => {
    if (row.metadata.archived || row.metadata.removed) integrations.delete(row.id)
    if (row.status === "unknown" || row.metadata.archived || row.metadata.removed) statuses.delete(row.id)
    else statuses.set(row.id, row.status)
  }

  const append = (event: {
    readonly sessionId: string
    readonly type: StoredType
    readonly processId?: number | undefined
    readonly turnId?: number | undefined
    readonly inboxId?: number | undefined
    readonly data?: Readonly<Record<string, unknown>>
    readonly at?: number
  }) =>
    Effect.gen(function* () {
      const buffer = yield* TxBuffer
      if (buffer === undefined) return yield* Effect.die(new Error("append outside a transaction"))
      if (buffer.closed || (yield* Effect.fiberId) !== buffer.fiberId)
        return yield* Effect.die(new Error("append not from the transaction fiber"))
      const at = event.at ?? (yield* now)
      const data = JSON.parse(JSON.stringify(event.data ?? {})) as Readonly<Record<string, unknown>>
      const [row] = yield* sql<{ id: number }>`INSERT INTO event ${sql.insert({
        at,
        sessionId: event.sessionId,
        type: event.type,
        ...(event.processId === undefined ? {} : { processId: event.processId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.inboxId === undefined ? {} : { inboxId: event.inboxId }),
        data: JSON.stringify(data),
      })} RETURNING id`
      const id = row!.id
      const stored: StoredEvent = {
        id,
        at,
        sessionId: event.sessionId,
        type: event.type,
        data,
        ...(event.processId === undefined ? {} : { processId: event.processId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.inboxId === undefined ? {} : { inboxId: event.inboxId }),
      }
      buffer.events.push(stored)
      return id
    })

  const tx = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if ((yield* TxBuffer) !== undefined) return yield* body
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const buffer = { events: [] as Array<EngineEvent>, fiberId: yield* Effect.fiberId, closed: false }
          const result = yield* sql
            .withTransaction(restore(Effect.provideService(body, TxBuffer, buffer)))
            .pipe(Effect.ensuring(Effect.sync(() => (buffer.closed = true))))
          yield* bus.published(buffer.events)
          return result
        }),
      )
    })

  const notify = (event: LiveEvent) =>
    Effect.gen(function* () {
      const buffer = yield* TxBuffer
      if (buffer !== undefined && !buffer.closed) buffer.events.push(event)
      else yield* bus.observe(event)
    })

  const projectPrefixTaken = (short: string) =>
    sql`SELECT 1 FROM project WHERE id >= ${short} AND id < ${`${short}~`} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )
  const putRepositories = (id: string, repositories: ReadonlyArray<RepositoryRow>) =>
    Effect.forEach(
      repositories,
      (
        r,
      ) => sql`INSERT INTO project_repository ${sql.insert({ projectId: id, path: r.path, remoteUrl: r.remote ?? null })}
        ON CONFLICT (path) DO UPDATE SET remote_url = excluded.remote_url WHERE project_id = excluded.project_id`,
      { discard: true },
    )

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

  const notMain = sql`a.role != 'main'`
  const endedMain = sql`a.role = 'main' AND NOT EXISTS (SELECT 1 FROM project q WHERE q.entry_session_id = a.id)`
  const running = sql`p_ended IS NULL`
  const selectRaw = (where: ReadonlyArray<Statement.Fragment>, filter?: Statement.Fragment) =>
    sql<SessionSql>`SELECT * FROM (SELECT ${SESSION_COLUMNS} ${where.length === 0 ? sql`` : sql`WHERE ${sql.and(where)}`}) ${filter ? sql`WHERE ${filter}` : sql``} ORDER BY created_at, id`
  const decodeRows = (rows: ReadonlyArray<SessionSql>) =>
    decodeSessions(
      rows.map((row) => {
        const decoded = fromColumns(row, statuses.get(row.id) ?? "unknown", integrations.get(row.id))
        const at = row.tId === null || row.tEnd !== null ? undefined : prompted.get(row.tId)
        return at === undefined ? decoded : { ...decoded, turnPromptedAt: at }
      }),
    )
  const selectSessions = (where: ReadonlyArray<Statement.Fragment>, endedMains = false, filter?: Statement.Fragment) =>
    selectRaw([endedMains ? sql`(${notMain} OR ${endedMain})` : notMain, ...where], filter).pipe(
      Effect.flatMap(decodeRows),
    )
  const findSession = (id: string) => selectSessions([sql`a.id = ${id}`]).pipe(Effect.map((rows) => rows[0]))
  const readSession = (id: string) => selectSessions([sql`a.id = ${id}`], true).pipe(Effect.map((rows) => rows[0]))
  const anySession = (id: string) =>
    selectRaw([sql`a.id = ${id}`]).pipe(
      Effect.map((rows) => {
        const row = rows[0]
        return row === undefined ? undefined : { row, current: currentOf(row) }
      }),
    )

  const placed = (projectIdValue: string, current: Current | undefined) =>
    current !== undefined && current.ended === null && current.start.terminal !== "" && !moving.has(projectIdValue)

  const findCoordinators = (project?: string) =>
    selectRaw([
      sql`a.id IN (SELECT entry_session_id FROM project ${project === undefined ? sql`` : sql`WHERE id = ${project}`})`,
    ]).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const current = currentOf(row)
            const start = current?.start
            const [project] = yield* sql<{
              directory: string | null
            }>`SELECT directory FROM project WHERE id = ${row.project}`
            const [own] = yield* sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${row.id}`
            const integration =
              integrations.get(row.id) ??
              (row.integration !== null ? (JSON.parse(row.integration) as Integration) : undefined)
            const pid = row.pid ?? start?.pid
            const here = placed(row.project, current)
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

  const inbox = (where: Statement.Fragment, order = sql`m.id`) =>
    sql<InboxSql>`SELECT m.id, m.recipient_session_id, m.kind, m.sender_session_id, m.content, m.status,
        te.data AS turn_end
      FROM inbox m LEFT JOIN event te ON te.id = m.result_event_id
      WHERE ${where} ORDER BY ${order}`.pipe(
      Effect.map((rows) => rows.map(toInbox)),
      Effect.flatMap(decodeInbox),
    )
  const inboxIn = (ids: ReadonlyArray<number>) => inbox(sql.in("m.id", ids))
  const findSend = (sessionId: string, status: InboxStatus) =>
    inbox(sql`m.recipient_session_id = ${sessionId} AND m.kind = 'send' AND m.status = ${storedStatus(status)}`)
  const entryOf = (projectIdValue: string) => sql`(SELECT entry_session_id FROM project WHERE id = ${projectIdValue})`

  const queuedBy = (sessionId: string, request: string) =>
    sql<{ id: number }>`SELECT inbox_id AS id FROM event WHERE session_id = ${sessionId} AND type = 'inbox.queued'
        AND json_extract(data, '$.request') = ${request} LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.id))

  const spawnedBy = (project: string, request: string) =>
    sql<{ id: string; data: string }>`SELECT s.id, p.data FROM session s
        JOIN event q ON q.session_id = s.id AND q.type = 'inbox.queued'
        JOIN inbox i ON i.id = q.inbox_id AND i.kind = 'task'
        JOIN event p ON p.id = (SELECT min(id) FROM event WHERE session_id = s.id AND type = 'process.start')
      WHERE s.project_id = ${project} AND json_extract(q.data, '$.request') = ${request} LIMIT 1`.pipe(
      Effect.map((rows) => {
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

  const openTurn = (sessionId: string) =>
    sql<{ id: number }>`SELECT t.id FROM event t WHERE t.id = (SELECT max(id) FROM event WHERE session_id = ${sessionId}
        AND type = 'turn.start') AND NOT EXISTS (SELECT 1 FROM event e WHERE e.turn_id = t.id AND e.type = 'turn.end')`.pipe(
      Effect.map((rows) => rows[0]?.id),
    )

  const moveInbox = (where: Statement.Fragment, to: string) =>
    tx(
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: number
          status: string
          recipient: string | null
          sender: string | null
        }>`SELECT id, status, recipient_session_id AS recipient, sender_session_id AS sender FROM inbox WHERE ${where}`
        const moved = rows.filter((r) => r.status !== to)
        if (moved.length === 0) return [] as ReadonlyArray<number>
        yield* sql`UPDATE inbox SET status = ${to} WHERE ${sql.in(
          "id",
          moved.map((r) => r.id),
        )}`
        const at = yield* now
        for (const r of moved) {
          const sessionId = r.recipient ?? r.sender!
          const turnId = to === "delivered" && r.recipient !== null ? yield* openTurn(r.recipient) : undefined
          yield* append({
            sessionId,
            type: "inbox.status",
            inboxId: r.id,
            turnId,
            at,
            data: { to },
          })
        }
        return moved.map((r) => r.id)
      }),
    )

  const insertInboxSql = (row: {
    readonly recipient: string | null
    readonly kind: string
    readonly sender: string | null
    readonly content: string
    readonly resultEventId?: number
    readonly status: string
    readonly request?: string | undefined
  }) =>
    Effect.gen(function* () {
      const [inserted] = yield* sql<{ id: number }>`INSERT INTO inbox ${sql.insert({
        ...(row.recipient === null ? {} : { recipientSessionId: row.recipient }),
        kind: row.kind,
        ...(row.sender === null ? {} : { senderSessionId: row.sender }),
        content: row.content,
        ...(row.resultEventId === undefined ? {} : { resultEventId: row.resultEventId }),
        status: row.status,
      })} RETURNING id`
      const id = inserted!.id
      const at = yield* now
      const sessionId = row.recipient ?? row.sender!
      yield* append({
        sessionId,
        type: "inbox.queued",
        inboxId: id,
        at,
        data: row.request === undefined ? {} : { request: row.request },
      })
      if (row.status !== "pending" && row.kind !== "task")
        yield* append({
          sessionId,
          type: "inbox.status",
          inboxId: id,
          at,
          data: { to: row.status },
        })
      return id
    })

  const linkTask = (sessionId: string, turnId: number, at: number) =>
    Effect.gen(function* () {
      const [task] = yield* sql<{ id: number }>`SELECT i.id FROM inbox i WHERE i.recipient_session_id = ${sessionId}
        AND i.kind = 'task' AND i.status = 'delivered'
        AND NOT EXISTS (SELECT 1 FROM event e WHERE e.inbox_id = i.id AND e.type = 'inbox.status')`
      if (task !== undefined)
        yield* append({
          sessionId,
          type: "inbox.status",
          inboxId: task.id,
          turnId,
          at,
          data: { to: "delivered" },
        })
    })

  const endProcess = (id: string, reason: EndReason, at?: number) =>
    Effect.gen(function* () {
      const found = yield* anySession(id)
      const current = found?.current
      if (current === undefined || current.ended !== null) return false
      yield* append({
        sessionId: id,
        type: "process.end",
        processId: current.id,
        ...(at === undefined ? {} : { at }),
        data: { reason },
      })
      integrations.delete(id)
      return true
    })

  const startProcess = (id: string, start: ProcessStart, at?: number) =>
    Effect.gen(function* () {
      const before = (yield* anySession(id))?.current
      const opening =
        before !== undefined && before.ended === null && before.start.terminal === "" && start.terminal !== ""
      const data: Record<string, unknown> = {
        harness: start.harness,
        runtime: start.runtime,
        machine: start.machine,
        terminal: start.terminal,
        ...(start.provider ? { provider: start.provider } : {}),
        ...(start.model ? { model: start.model } : {}),
        ...(start.routing === undefined ? {} : { routing: start.routing }),
        ...(start.resume ? { resume: start.resume } : {}),
        ...(start.pid === undefined ? {} : { pid: start.pid }),
      }
      const processId = yield* append({
        sessionId: id,
        type: "process.start",
        data,
        ...(at === undefined ? {} : { at }),
      })
      if (opening) {
        const copied = yield* sql<{ at: number; type: "process.ready" | "process.conversation"; data: string }>`
          SELECT at, type, data FROM event
          WHERE process_id = ${before.id} AND type IN ('process.ready', 'process.conversation') ORDER BY id`
        for (const row of copied)
          yield* append({ sessionId: id, type: row.type, processId, at: row.at, data: JSON.parse(row.data) })
      } else integrations.delete(id)
      return processId
    })

  const endTurn = (id: string, end: TurnEnd, at?: number) =>
    Effect.gen(function* () {
      const found = yield* anySession(id)
      const t = at ?? (yield* now)
      let turnId = yield* openTurn(id)
      if (turnId === undefined)
        turnId = yield* append({
          sessionId: id,
          type: "turn.start",
          processId: found?.current?.id,
          at: t,
          data: {},
        })
      prompted.delete(turnId)
      return yield* append({
        sessionId: id,
        type: "turn.end",
        processId: found?.current?.id,
        turnId,
        at: t,
        data: {
          status: end.status,
          ...(end.output === undefined ? {} : { output: end.output }),
          ...(end.report === undefined ? {} : { report: end.report }),
          ...(end.failure === undefined ? {} : { failure: end.failure }),
        },
      })
    })

  const insertInboxRow = (row: NewInboxRow, end?: TurnEnd, at?: number, request?: string) =>
    Effect.gen(function* () {
      if (row.kind === "send") {
        const id = yield* insertInboxSql({
          recipient: row.sessionId,
          kind: "send",
          sender: null,
          content: row.message,
          status: "pending",
          request,
        })
        return (yield* inboxIn([id]))[0]!
      }
      const [route] = yield* sql<{ recipient: string | null; entry: number | null; project: string }>`SELECT
          CASE WHEN r.id IS NOT NULL AND r.ended_at IS NULL THEN r.id ELSE p.entry_session_id END AS recipient,
          (p.entry_session_id IS NOT NULL) AS entry, p.id AS project
        FROM session s JOIN project p ON p.id = s.project_id LEFT JOIN session r ON r.id = s.report_to_session_id
        WHERE s.id = ${row.sessionId}`
      const recipient = route?.recipient ?? null
      const [entry] =
        route === undefined
          ? []
          : yield* sql<{ id: string | null }>`SELECT entry_session_id AS id FROM project WHERE id = ${route.project}`
      const toEntry = recipient !== null && recipient === entry?.id
      const present =
        recipient !== null && (!toEntry || placed(route!.project, (yield* anySession(recipient))?.current))
      const resultEventId =
        row.kind === "result"
          ? yield* endTurn(
              row.sessionId,
              end ?? {
                status: roundStatus(row.details.status),
                ...(typeof row.details.error === "string" && row.details.error !== ""
                  ? { failure: failureOf(row.details.error)! }
                  : {}),
              },
              at,
            )
          : undefined
      const id = yield* insertInboxSql({
        recipient: recipient ?? row.sessionId,
        kind: row.kind,
        sender: row.sessionId,
        content: row.message,
        ...(resultEventId === undefined ? {} : { resultEventId }),
        status: present ? "pending" : "dropped",
      })
      return (yield* inboxIn([id]))[0]!
    })

  const updateSession = (id: string, patch: SessionPatch) =>
    Effect.gen(function* () {
      if (Object.keys(patch).length === 0) return
      const current = yield* findSession(id)
      if (current === undefined) return
      const next = { ...current, ...patch }
      remember(next)
      yield* notify({ type: "live.session", sessionId: id })
      if (patch.name !== undefined && patch.name !== current.name)
        yield* sql`UPDATE session SET name = ${patch.name} WHERE id = ${id}`
      const ending = !!(next.metadata.archived || next.metadata.removed)
      if (ending && !(current.metadata.archived || current.metadata.removed))
        yield* sql`UPDATE session SET ended_at = ${yield* now} WHERE id = ${id} AND ended_at IS NULL`
      const p = (yield* anySession(id))!.current
      const routing = patch.metadata?.routing
      const choicePatched =
        (patch.harnessId !== undefined && patch.harnessId !== current.harnessId) ||
        (patch.provider !== undefined && patch.provider !== current.provider) ||
        (patch.model !== undefined && patch.model !== current.model) ||
        (patch.metadata !== undefined && JSON.stringify(routing) !== JSON.stringify(current.metadata.routing))
      const opened =
        (patch.startedAt !== undefined && patch.startedAt !== null) ||
        (patch.address !== undefined &&
          (patch.address.id !== current.address.id || patch.address.machine !== current.address.machine))
      if (p === undefined || choicePatched || opened) {
        const harnessChanged = next.harnessId !== current.harnessId
        const resume =
          patch.harnessSessionId !== undefined
            ? patch.harnessSessionId
            : harnessChanged
              ? null
              : current.harnessSessionId
        const nextRouting = patch.metadata !== undefined ? routing : current.metadata.routing
        yield* startProcess(
          id,
          {
            harness: next.harnessId,
            ...(next.provider ? { provider: next.provider } : {}),
            ...(next.model ? { model: next.model } : {}),
            ...(nextRouting === undefined ? {} : { routing: nextRouting }),
            runtime: current.runtime,
            machine: next.address.machine,
            terminal: next.address.id,
            ...(resume ? { resume } : {}),
          },
          patch.startedAt ?? undefined,
        )
      } else if (
        patch.harnessSessionId !== undefined &&
        patch.harnessSessionId !== null &&
        patch.harnessSessionId !== current.harnessSessionId
      ) {
        yield* append({
          sessionId: id,
          type: "process.conversation",
          processId: p.id,
          data: { conversation: patch.harnessSessionId },
        })
      }
      if (patch.exitedAt !== undefined && patch.exitedAt !== null && current.exitedAt === null)
        yield* endProcess(id, patch.end ?? "exited", patch.exitedAt)
      if (patch.turnState === "open") {
        const open = yield* openTurn(id)
        const at = next.turnPromptedAt || (yield* now)
        if (open !== undefined) {
          if (patch.turnPromptedAt !== undefined) prompted.set(open, at)
        } else {
          yield* append({
            sessionId: id,
            type: "turn.start",
            processId: (yield* anySession(id))!.current?.id,
            at,
            data: {},
          })
        }
      } else if (patch.turnState !== undefined && patch.turnState !== "none" && current.turnState === "open") {
        const open = yield* openTurn(id)
        if (open !== undefined) prompted.delete(open)
        if (open !== undefined)
          yield* append({
            sessionId: id,
            type: "turn.end",
            processId: (yield* anySession(id))!.current?.id,
            turnId: open,
            data: { status: patch.turnState },
          })
      }
    })

  const dropWaiting = (
    projectIdValue: string,
    guard?: { readonly runtime: string; readonly address: string } | "absent",
  ) =>
    Effect.gen(function* () {
      if (guard !== undefined) {
        const [main] = yield* findCoordinators(projectIdValue)
        if (guard === "absent") {
          if (main?.runtime || moving.has(projectIdValue)) return
        } else if (
          !main?.runtime ||
          !main.address ||
          main.runtime !== guard.runtime ||
          encodeAddress(main.address) !== guard.address
        )
          return
      }
      yield* moveInbox(
        sql`status = 'pending' AND kind NOT IN ${sql.literal(TO_SESSION)} AND recipient_session_id = ${entryOf(projectIdValue)}`,
        "dropped",
      )
    })

  const mainsAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string; project: string }>`SELECT s.id, s.project_id AS project FROM session s
        JOIN project q ON q.entry_session_id = s.id
        JOIN event p ON p.id = ${currentStart(sql`s.id`)}
        WHERE json_extract(p.data, '$.runtime') = ${runtime} AND json_extract(p.data, '$.machine') = ${address.machine}
          AND json_extract(p.data, '$.terminal') = ${address.id}
          AND NOT EXISTS (SELECT 1 FROM event e WHERE e.process_id = p.id AND e.type = 'process.end')
          ${except === undefined ? sql`` : sql`AND s.project_id != ${except}`}`
      return rows.filter((r) => !moving.has(r.project))
    })

  const clearMainAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    Effect.gen(function* () {
      for (const main of yield* mainsAt(runtime, address, except)) {
        yield* endProcess(main.id, "exited")
        yield* dropWaiting(main.project)
      }
    })

  const sessionPrefixTaken = (short: string) =>
    sql`SELECT 1 FROM session WHERE id >= ${short} AND id < ${`${short}~`} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )
  const unusedId = newId(sessionPrefixTaken)

  const conversationOf = (id: string) =>
    anySession(id).pipe(
      Effect.map((found) => ({
        current: found?.current,
        conversation: found === undefined ? null : (found.row.conversation ?? found.current?.start.resume ?? null),
      })),
    )

  return {
    sql,
    currentStart,
    now,
    statuses,
    integrations,
    moving,
    remember,
    append,
    tx,
    notify,
    projectPrefixTaken,
    putRepositories,
    notMain,
    running,
    selectRaw,
    selectSessions,
    findSession,
    readSession,
    anySession,
    findCoordinators,
    inbox,
    inboxIn,
    findSend,
    entryOf,
    queuedBy,
    spawnedBy,
    openTurn,
    moveInbox,
    insertInboxSql,
    linkTask,
    endProcess,
    startProcess,
    insertInboxRow,
    updateSession,
    dropWaiting,
    mainsAt,
    clearMainAt,
    unusedId,
    conversationOf,
  }
})

export type Store = Effect.Success<typeof makeStore>
