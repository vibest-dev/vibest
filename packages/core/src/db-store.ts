import {
  InboxMoved,
  InboxQueued,
  OutboxQueued,
  ProcessConversation,
  ProcessEnded,
  type ProcessEndReason,
  ProcessPlaced,
  ProcessStarted,
  SessionEnded,
  SessionRenamed,
  TurnEnded,
  TurnStarted,
} from "@vibest/schema/event"
import { newId, randomId } from "@vibest/schema/id"
import { AgentStatus, InboxStatus, RuntimeAddress } from "@vibest/schema/session"
import { Clock, Effect, Schema } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { Bus, type EngineEvent, type LiveEvent } from "./bus.ts"
import {
  encodeAddress,
  SessionRow,
  storedStatus,
  type SessionPatch,
  type NewInboxRow,
  type RepositoryRow,
  type ProcessStart,
  type Integration,
  type TurnEnd,
} from "./db-rows.ts"
import { makeJournal } from "./journal.ts"
import { coordinatorOf, decodeCoordinators, decodeSessions, ledgerReads, sessionOf } from "./ledger-read.ts"
import { Routing } from "./plugins.ts"
import { envelope } from "./results.ts"

export type Current = {
  readonly id: number
  readonly start: ProcessStart
  readonly ended: number | null
  readonly terminal: string | null
  readonly conversation: string | null
  readonly integration: Integration | undefined
  readonly readyAt: number | null
}

type ProcessColumns = {
  readonly id: number
  readonly harness: string
  readonly provider: string | null
  readonly model: string | null
  readonly routing: string | null
  readonly runtime: string
  readonly terminal: string | null
  readonly pid: number | null
  readonly conversation: string | null
  readonly integrationVersion: string | null
  readonly integrationProtocol: number | null
  readonly readyAt: number | null
  readonly endedAt: number | null
}

const encodeRouting = Schema.encodeSync(Routing)
const routingJson = (routing: unknown) =>
  routing === undefined || routing === null ? null : JSON.stringify(encodeRouting(routing as Routing))

const currentOf = (row: ProcessColumns): Current => ({
  id: row.id,
  start: {
    harness: row.harness,
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.routing === null ? {} : { routing: JSON.parse(row.routing) as unknown }),
    runtime: row.runtime,
    terminal: row.terminal ?? "",
    ...(row.pid === null ? {} : { pid: row.pid }),
  },
  ended: row.endedAt,
  terminal: row.terminal,
  conversation: row.conversation,
  integration:
    row.integrationVersion === null || row.integrationProtocol === null
      ? undefined
      : { version: row.integrationVersion, protocol: row.integrationProtocol },
  readyAt: row.readyAt,
})

const PROCESS_COLUMNS = `id, harness, provider, model, routing, runtime, terminal, pid, conversation,
  integration_version, integration_protocol, ready_at, ended_at`

export const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const bus = yield* Bus
  const journal = yield* makeJournal<LiveEvent>((events: ReadonlyArray<EngineEvent>) => bus.published(events))
  const { emit, commit: tx, notify } = journal
  const reads = ledgerReads(sql)
  const now = Clock.currentTimeMillis
  const statuses = new Map<string, AgentStatus>()
  const integrations = new Map<string, Integration>()
  const prompted = new Map<number, number>()
  const moving = new Set<string>()
  const remember = (row: Pick<SessionRow, "id" | "status" | "metadata">) => {
    if (row.metadata.archived || row.metadata.removed) integrations.delete(row.id)
    if (row.status === "unknown" || row.metadata.archived || row.metadata.removed) statuses.delete(row.id)
    else statuses.set(row.id, row.status)
  }

  const projectPrefixTaken = (short: string) =>
    sql`SELECT 1 FROM project WHERE id >= ${short} AND id < ${`${short}~`} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )

  const repositoriesOf = (repositories: ReadonlyArray<RepositoryRow>) =>
    repositories.map((r) => ({ path: r.path, ...(r.remote ? { remote: r.remote } : {}) }))

  const changedRepositories = (id: string, repositories: ReadonlyArray<RepositoryRow>) =>
    Effect.gen(function* () {
      const changed: Array<RepositoryRow> = []
      for (const r of repositories) {
        const [row] = yield* sql<{ projectId: string; remoteUrl: string | null }>`SELECT project_id, remote_url
          FROM project_repository WHERE path = ${r.path}`
        if (row === undefined || (row.projectId === id && row.remoteUrl !== (r.remote || null))) changed.push(r)
      }
      return repositoriesOf(changed)
    })

  const notMain = sql`s.role != 'main'`
  const endedMain = sql`s.role = 'main' AND NOT EXISTS (SELECT 1 FROM project q WHERE q.entry_session_id = s.id)`
  const running = sql`p_ended IS NULL`
  const selectRaw = reads.sessionRows
  const selectSessions = (where: ReadonlyArray<Statement.Fragment>, endedMains = false, filter?: Statement.Fragment) =>
    selectRaw([endedMains ? sql`(${notMain} OR ${endedMain})` : notMain, ...where], filter).pipe(
      Effect.flatMap((rows) =>
        decodeSessions(
          rows.map((row) =>
            sessionOf(row, {
              status: statuses.get(row.id) ?? "unknown",
              integration: integrations.get(row.id),
              promptedAt: row.tId === null ? undefined : prompted.get(row.tId),
            }),
          ),
        ),
      ),
    )
  const findSession = (id: string) => selectSessions([sql`s.id = ${id}`]).pipe(Effect.map((rows) => rows[0]))
  const readSession = (id: string) => selectSessions([sql`s.id = ${id}`], true).pipe(Effect.map((rows) => rows[0]))

  const currentProcess = (id: string) =>
    sql<ProcessColumns>`SELECT ${sql.literal(PROCESS_COLUMNS)} FROM process
      WHERE id = (SELECT process_id FROM session WHERE id = ${id})`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : currentOf(rows[0]))),
    )
  const liveProcess = (id: string) =>
    sql<ProcessColumns>`SELECT ${sql.literal(PROCESS_COLUMNS)} FROM process
      WHERE session_id = ${id} AND ended_at IS NULL`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : currentOf(rows[0]))),
    )

  const placed = (projectIdValue: string, current: Current | undefined) =>
    current !== undefined && current.ended === null && current.terminal !== null && !moving.has(projectIdValue)

  const findCoordinators = (project?: string) =>
    reads
      .coordinatorRows(project)
      .pipe(
        Effect.flatMap((rows) =>
          decodeCoordinators(
            rows.map((row) =>
              coordinatorOf(row, { integration: integrations.get(row.id), moving: moving.has(row.project) }),
            ),
          ),
        ),
      )

  const inbox = reads.inboxWhere
  const inboxIn = (ids: ReadonlyArray<number>) => inbox(sql.in("m.id", ids))
  const findSend = (sessionId: string, status: InboxStatus) =>
    inbox(sql`m.recipient_session_id = ${sessionId} AND m.kind != 'task' AND m.status = ${storedStatus(status)}
        AND NOT EXISTS (SELECT 1 FROM project q WHERE q.entry_session_id = m.recipient_session_id)`)
  const entryOf = (projectIdValue: string) => sql`(SELECT entry_session_id FROM project WHERE id = ${projectIdValue})`

  const openTurn = (sessionId: string) =>
    sql<{ id: number }>`SELECT id FROM turn WHERE session_id = ${sessionId} AND status IS NULL`.pipe(
      Effect.map((rows) => rows[0]?.id),
    )

  const currentProcessId = (sessionId: string) =>
    sql<{ id: number | null }>`SELECT process_id AS id FROM session WHERE id = ${sessionId}`.pipe(
      Effect.map((rows) => rows[0]?.id ?? undefined),
    )

  const startTurn = (sessionId: string, at: number, typed?: string) =>
    Effect.gen(function* () {
      const process = yield* currentProcessId(sessionId)
      return yield* emit(TurnStarted, {
        sessionId,
        at,
        data: { ...(process === undefined ? {} : { process }), ...(typed ? { typed } : {}) },
      })
    })

  const moveInbox = (where: Statement.Fragment, to: "pending" | "delivering" | "delivered" | "failed" | "dropped") =>
    tx(
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: number
          status: string
          recipient: string | null
          sender: string | null
        }>`SELECT id, status, recipient_session_id AS recipient, sender_session_id AS sender FROM inbox WHERE ${where}`
        const moved = rows.filter((r) => r.status !== to)
        const at = yield* now
        for (const r of moved) {
          const turn = to === "delivered" && r.recipient !== null ? yield* openTurn(r.recipient) : undefined
          yield* emit(InboxMoved, {
            sessionId: r.recipient ?? r.sender!,
            at,
            data: { inbox: r.id, to, ...(turn === undefined ? {} : { turn }) },
          })
        }
        return moved.map((r) => r.id) as ReadonlyArray<number>
      }),
    )

  const queueInbox = (row: {
    readonly recipient: string | null
    readonly kind: "task" | "send" | "notice"
    readonly sender: string | null
    readonly content: string
    readonly status: "pending" | "delivered" | "dropped"
    readonly request?: string | undefined
    readonly peerItem?: string | undefined
    readonly at?: number | undefined
  }) =>
    emit(InboxQueued, {
      sessionId: row.recipient ?? row.sender!,
      ...(row.at === undefined ? {} : { at: row.at }),
      data: {
        kind: row.kind,
        ...(row.recipient === null ? {} : { recipient: row.recipient }),
        ...(row.sender === null ? {} : { sender: row.sender }),
        content: row.content,
        status: row.status,
        ...(row.request === undefined ? {} : { request: row.request }),
        ...(row.peerItem === undefined ? {} : { peerItem: row.peerItem }),
      },
    })

  const linkTask = (sessionId: string, turn: number, at: number) =>
    Effect.gen(function* () {
      const [task] = yield* sql<{ id: number }>`SELECT id FROM inbox WHERE recipient_session_id = ${sessionId}
        AND kind = 'task' AND status = 'delivered' AND seq = id`
      if (task !== undefined)
        yield* emit(InboxMoved, { sessionId, at, data: { inbox: task.id, to: "delivered", turn } })
    })

  const endProcess = (id: string, reason: ProcessEndReason, at?: number) =>
    Effect.gen(function* () {
      const current = yield* currentProcess(id)
      if (current === undefined || current.ended !== null) return false
      yield* emit(ProcessEnded, {
        sessionId: id,
        ...(at === undefined ? {} : { at }),
        data: { process: current.id, reason },
      })
      integrations.delete(id)
      return true
    })

  const sameChoice = (live: Current, start: ProcessStart) =>
    live.start.harness === start.harness &&
    live.start.provider === start.provider &&
    live.start.model === start.model &&
    live.start.runtime === start.runtime &&
    routingJson(live.start.routing) === routingJson(start.routing)

  const startProcess = (id: string, start: ProcessStart, at?: number) =>
    Effect.gen(function* () {
      const live = yield* liveProcess(id)
      const stamp = at === undefined ? {} : { at }
      if (live !== undefined && live.terminal === null && start.terminal !== "" && sameChoice(live, start)) {
        yield* emit(ProcessPlaced, {
          sessionId: id,
          ...stamp,
          data: { process: live.id, terminal: start.terminal, ...(start.pid === undefined ? {} : { pid: start.pid }) },
        })
        if (start.resume && start.resume !== live.conversation)
          yield* emit(ProcessConversation, {
            sessionId: id,
            ...stamp,
            data: { process: live.id, conversation: start.resume },
          })
        return live.id
      }
      if (live !== undefined)
        yield* emit(ProcessEnded, { sessionId: id, ...stamp, data: { process: live.id, reason: "superseded" } })
      const seq = yield* emit(ProcessStarted, {
        sessionId: id,
        ...stamp,
        data: {
          harness: start.harness,
          ...(start.provider ? { provider: start.provider } : {}),
          ...(start.model ? { model: start.model } : {}),
          ...(start.routing === undefined || start.routing === null ? {} : { routing: start.routing as Routing }),
          ...(start.resume ? { resume: start.resume } : {}),
          runtime: start.runtime,
          ...(start.terminal === "" ? {} : { terminal: start.terminal }),
          ...(start.pid === undefined ? {} : { pid: start.pid }),
        },
      })
      integrations.delete(id)
      return seq
    })

  const endTurn = (id: string, end: TurnEnd, at?: number) =>
    Effect.gen(function* () {
      const t = at ?? (yield* now)
      const turn = (yield* openTurn(id)) ?? (yield* startTurn(id, t))
      prompted.delete(turn)
      yield* emit(TurnEnded, {
        sessionId: id,
        at: t,
        data: {
          turn,
          status: end.status,
          ...(end.report === undefined ? {} : { report: end.report }),
          ...(end.failure === undefined ? {} : { failure: end.failure }),
        },
      })
      return turn
    })

  const origins = (sessionId: string) =>
    sql<{
      peer: string | null
      project: string | null
      reportTo: string | null
    }>`SELECT origin_peer AS peer, origin_project AS project, origin_session AS report_to
      FROM session WHERE id = ${sessionId}`.pipe(Effect.map((rows) => rows[0]))

  const queueForPeer = (
    peer: string,
    reportTo: string | null,
    row: { readonly sessionId: string; readonly content: string; readonly at?: number },
  ) =>
    Effect.gen(function* () {
      if (reportTo === null) return false
      if ((yield* sql`SELECT 1 FROM peer WHERE id = ${peer}`).length === 0) return false
      yield* emit(OutboxQueued, {
        sessionId: row.sessionId,
        ...(row.at === undefined ? {} : { at: row.at }),
        data: { id: randomId(), peer, kind: "notice", content: row.content },
      })
      yield* notify({ type: "live.outbox", peerId: peer })
      return true
    })

  const liveRecipient = (id: string) =>
    Effect.gen(function* () {
      const [route] = yield* sql<{
        project: string
        entry: string | null
      }>`SELECT s.project_id AS project, p.entry_session_id AS entry
        FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ${id}`
      if (route === undefined) return false
      if (route.entry === id) return placed(route.project, yield* currentProcess(id))
      const session = yield* findSession(id)
      return session !== undefined && !session.metadata.archived && !session.metadata.removed
    })

  const renderedSend = (recipient: string, sender: string | undefined, message: string) =>
    Effect.gen(function* () {
      if (sender === undefined) return message
      const [from] = yield* sql<{ name: string }>`SELECT name FROM session WHERE id = ${sender}`
      const [to] = yield* sql<{ creator: string | null; entry: string | null }>`SELECT
          s.parent_session_id AS creator, p.entry_session_id AS entry
        FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ${recipient}`
      const toEntry = to?.entry === recipient
      if (!toEntry && (sender === to?.creator || sender === to?.entry)) return message
      return envelope(
        "agent-message",
        [["agent-id", sender], ...(toEntry ? ([["title", from?.name ?? ""]] as const) : [])],
        ["message", message],
      )
    })

  const queueSend = (recipient: string, sender: string | undefined, message: string, request?: string) =>
    Effect.gen(function* () {
      const id = yield* queueInbox({
        recipient,
        kind: "send",
        sender: sender ?? null,
        content: yield* renderedSend(recipient, sender, message),
        status: "pending",
        request,
      })
      return (yield* inboxIn([id]))[0]!
    })

  const noticeTo = (recipient: string, content: string) =>
    Effect.gen(function* () {
      if (!(yield* liveRecipient(recipient))) return false
      yield* queueInbox({ recipient, kind: "notice", sender: null, content, status: "pending" })
      return true
    })

  const insertInboxRow = (row: NewInboxRow, at?: number) =>
    Effect.gen(function* () {
      const [route] = yield* sql<{
        recipient: string | null
        project: string
      }>`SELECT
          CASE WHEN r.id IS NOT NULL AND r.ended_at IS NULL THEN r.id ELSE p.entry_session_id END AS recipient,
          p.id AS project
        FROM session s JOIN project p ON p.id = s.project_id LEFT JOIN session r ON r.id = s.parent_session_id
        WHERE s.id = ${row.sessionId}`
      const insert = (recipient: string, status: "pending" | "dropped") =>
        queueInbox({
          recipient,
          kind: "notice",
          sender: row.sessionId,
          content: row.message,
          status,
          at,
        }).pipe(Effect.flatMap((id) => inboxIn([id])))
      const origin = yield* origins(row.sessionId)
      if (origin?.peer) {
        const [queued] = yield* insert(row.sessionId, "dropped")
        yield* queueForPeer(origin.peer, origin.reportTo, {
          sessionId: row.sessionId,
          content: row.message,
          ...(at === undefined ? {} : { at }),
        })
        return queued!
      }
      const recipient = route?.recipient ?? null
      const [entry] =
        route === undefined
          ? []
          : yield* sql<{ id: string | null }>`SELECT entry_session_id AS id FROM project WHERE id = ${route.project}`
      const toEntry = recipient !== null && recipient === entry?.id
      const present = recipient !== null && (!toEntry || placed(route!.project, yield* currentProcess(recipient)))
      const [queued] = yield* insert(recipient ?? row.sessionId, present ? "pending" : "dropped")
      return queued!
    })

  const tellSender = (sender: string, content: string) =>
    Effect.gen(function* () {
      if (yield* noticeTo(sender, content)) return
      yield* insertInboxRow({ sessionId: sender, message: content })
    })

  const tellSendersOf = (ids: ReadonlyArray<number>, reason: string) =>
    Effect.gen(function* () {
      if (ids.length === 0) return
      const sends = yield* sql<{
        sender: string
        recipient: string
        content: string
      }>`SELECT sender_session_id AS sender, recipient_session_id AS recipient, content FROM inbox
        WHERE ${sql.in("id", ids)} AND kind = 'send' AND sender_session_id IS NOT NULL ORDER BY id`
      const groups = Map.groupBy(sends, (s) => `${s.sender}\n${s.recipient}`)
      for (const group of groups.values()) {
        const { sender, recipient } = group[0]!
        yield* tellSender(
          sender,
          `A message to ${recipient} was not delivered: ${reason}\n\n${group.map((s) => s.content).join("\n\n")}`,
        )
      }
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
        yield* emit(SessionRenamed, { sessionId: id, data: { name: patch.name } })
      const ending = !!(next.metadata.archived || next.metadata.removed)
      if (ending && !(current.metadata.archived || current.metadata.removed))
        yield* emit(SessionEnded, { sessionId: id, data: { reason: "archived" } })
      const p = yield* currentProcess(id)
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
        yield* emit(ProcessConversation, {
          sessionId: id,
          data: { process: p.id, conversation: patch.harnessSessionId },
        })
      }
      if (patch.exitedAt !== undefined && patch.exitedAt !== null && current.exitedAt === null)
        yield* endProcess(id, patch.end ?? "exited", patch.exitedAt)
      if (patch.turnState === "open") {
        const open = yield* openTurn(id)
        const at = next.turnPromptedAt || (yield* now)
        if (open !== undefined) {
          if (patch.turnPromptedAt !== undefined) prompted.set(open, at)
        } else yield* startTurn(id, at)
      } else if (patch.turnState !== undefined && patch.turnState !== "none" && current.turnState === "open") {
        const open = yield* openTurn(id)
        if (open !== undefined) {
          prompted.delete(open)
          yield* emit(TurnEnded, { sessionId: id, data: { turn: open, status: patch.turnState } })
        }
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
      const dropped = yield* moveInbox(
        sql`status = 'pending' AND recipient_session_id = ${entryOf(projectIdValue)}`,
        "dropped",
      )
      yield* tellSendersOf(dropped, "the main agent is not running")
    })

  const sessionAt = (runtime: string, address: RuntimeAddress) =>
    sql<{ id: string }>`SELECT s.id FROM session s JOIN process p ON p.id = s.process_id
      WHERE s.role != 'main' AND p.runtime = ${runtime} AND p.terminal = ${address.id} AND p.ended_at IS NULL
      ORDER BY s.created_at, s.id
      LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.id))

  const mainsAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string; project: string }>`SELECT s.id, s.project_id AS project FROM session s
        JOIN project q ON q.entry_session_id = s.id
        JOIN process p ON p.id = s.process_id
        WHERE p.runtime = ${runtime} AND p.terminal = ${address.id} AND p.ended_at IS NULL
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
    currentProcess(id).pipe(
      Effect.map((current) => ({
        current,
        conversation: current === undefined ? null : current.conversation,
      })),
    )

  const addressedCreator = (id: string) =>
    sql<{ id: string | null }>`SELECT
        CASE WHEN s.origin_peer IS NOT NULL THEN s.origin_session
          WHEN r.id IS NOT NULL AND r.ended_at IS NULL THEN r.id
          ELSE p.entry_session_id END AS id
      FROM session s JOIN project p ON p.id = s.project_id
      LEFT JOIN session r ON r.id = s.parent_session_id
      WHERE s.id = ${id}`.pipe(Effect.map((rows) => rows[0]?.id ?? undefined))

  return {
    sql,
    reads,
    addressedCreator,
    now,
    statuses,
    integrations,
    moving,
    remember,
    emit,
    tx,
    notify,
    projectPrefixTaken,
    repositoriesOf,
    changedRepositories,
    notMain,
    running,
    selectRaw,
    selectSessions,
    findSession,
    readSession,
    currentProcess,
    currentProcessId,
    findCoordinators,
    inbox,
    inboxIn,
    findSend,
    entryOf,
    openTurn,
    startTurn,
    moveInbox,
    queueInbox,
    queueSend,
    noticeTo,
    tellSender,
    tellSendersOf,
    liveRecipient,
    queueForPeer,
    origins,
    linkTask,
    endProcess,
    startProcess,
    endTurn,
    insertInboxRow,
    updateSession,
    dropWaiting,
    sessionAt,
    mainsAt,
    clearMainAt,
    unusedId,
    conversationOf,
    placed,
  }
})

export type Store = Effect.Success<typeof makeStore>
