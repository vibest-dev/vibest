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
  ExecutionEnded,
  ExecutionStarted,
} from "@vibest/schema/event"
import { newId, randomId } from "@vibest/schema/id"
import { type AgentStatus, InboxStatus, RuntimeAddress } from "@vibest/schema/session"
import { Clock, Effect, Schema } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { Bus, type EngineEvent, type LiveEvent } from "./bus.ts"
import {
  SessionRow,
  type SessionPatch,
  type NewInboxRow,
  type RepositoryRow,
  type ProcessStart,
  type Integration,
  type ExecutionEnd,
} from "./db-rows.ts"
import { makeJournal } from "./journal.ts"
import { entryRow, decodeEntrySessions, decodeSessions, ledgerReads, sessionOf } from "./ledger-read.ts"
import { Routing } from "./plugins.ts"
import { noticeEnvelope, sessionEnvelope } from "./replies.ts"
import { SessionLive } from "./session/live.ts"

type InboxKey = { readonly session: string; readonly id: number }

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
  const sessionLive = yield* SessionLive
  const moving = new Set<string>()
  const remember = (row: Pick<SessionRow, "id" | "status" | "metadata">) =>
    row.metadata.archived || row.metadata.removed
      ? sessionLive.ended(row.id)
      : sessionLive.setStatus(row.id, row.status)

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

  const running = sql`p_ended IS NULL`
  const selectRaw = reads.sessionRows
  const selectSessions = (where: ReadonlyArray<Statement.Fragment>, filter?: Statement.Fragment) =>
    selectRaw(where, filter).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            return sessionOf(row, {
              status: yield* sessionLive.status(row.id),
              integration: yield* sessionLive.integration(row.id),
            })
          }),
        ),
      ),
      Effect.flatMap(decodeSessions),
    )
  const findSession = (id: string) => selectSessions([sql`s.id = ${id}`]).pipe(Effect.map((rows) => rows[0]))

  const currentProcess = (id: string) =>
    sql<ProcessColumns>`SELECT ${sql.literal(PROCESS_COLUMNS)} FROM process
      WHERE session_id = ${id} AND id = (SELECT process_id FROM session WHERE id = ${id})`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : currentOf(rows[0]))),
    )
  const liveProcess = (id: string) =>
    sql<ProcessColumns>`SELECT ${sql.literal(PROCESS_COLUMNS)} FROM process
      WHERE session_id = ${id} AND ended_at IS NULL`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : currentOf(rows[0]))),
    )

  const placed = (projectIdValue: string, current: Current | undefined) =>
    current !== undefined && current.ended === null && current.terminal !== null && !moving.has(projectIdValue)

  const findEntrySessions = (project?: string) =>
    reads.entryRows(project).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          sessionLive
            .integration(row.id)
            .pipe(Effect.map((integration) => entryRow(row, { integration, moving: moving.has(row.project) }))),
        ),
      ),
      Effect.flatMap(decodeEntrySessions),
    )

  const inbox = reads.inboxWhere
  const inboxIn = (session: string, ids: ReadonlyArray<number>) =>
    inbox(sql`m.session_id = ${session} AND ${sql.in("m.id", ids)}`)
  const keysIn = (keys: ReadonlyArray<InboxKey>) =>
    sql.or(keys.map((k) => sql`(session_id = ${k.session} AND id = ${k.id})`))
  const findSend = (sessionId: string, status: InboxStatus) =>
    inbox(sql`m.session_id = ${sessionId} AND m.kind != 'task' AND m.status = ${status}`)
  const entryIdOf = (projectIdValue: string) => sql`(SELECT entry_session_id FROM project WHERE id = ${projectIdValue})`

  const openExecution = (sessionId: string) =>
    sql<{ id: number }>`SELECT id FROM execution WHERE session_id = ${sessionId} AND outcome IS NULL`.pipe(
      Effect.map((rows) => rows[0]?.id),
    )

  const currentProcessId = (sessionId: string) =>
    sql<{ id: number | null }>`SELECT process_id AS id FROM session WHERE id = ${sessionId}`.pipe(
      Effect.map((rows) => rows[0]?.id ?? undefined),
    )

  const startExecution = (sessionId: string, at: number, typed?: string) =>
    Effect.gen(function* () {
      const process = yield* currentProcessId(sessionId)
      return yield* emit(ExecutionStarted, {
        sessionId,
        at,
        data: { ...(process === undefined ? {} : { process }), ...(typed ? { typed } : {}) },
      })
    })

  const moveInbox = (
    where: Statement.Fragment,
    to: "pending" | "delivering" | "delivered" | "failed" | "dropped",
    into?: number,
  ) =>
    tx(
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: number
          status: string
          session: string
        }>`SELECT id, status, session_id AS session FROM inbox WHERE ${where} ORDER BY session_id, id`
        const moved = rows.filter((r) => r.status !== to)
        const at = yield* now
        for (const r of moved) {
          const execution = to === "delivered" ? (into ?? (yield* openExecution(r.session))) : undefined
          yield* emit(InboxMoved, {
            sessionId: r.session,
            at,
            data: { inbox: r.id, to, ...(execution === undefined ? {} : { execution }) },
          })
        }
        return moved.map((r): InboxKey => ({ session: r.session, id: r.id }))
      }),
    )

  const queueInbox = (row: {
    readonly recipient: string
    readonly kind: "task" | "send" | "notice"
    readonly sender: string | null
    readonly content: string
    readonly status: "pending" | "delivered" | "dropped"
    readonly request?: string | undefined
    readonly peerItem?: string | undefined
    readonly at?: number | undefined
  }) =>
    emit(InboxQueued, {
      sessionId: row.recipient,
      ...(row.at === undefined ? {} : { at: row.at }),
      data: {
        kind: row.kind,
        recipient: row.recipient,
        ...(row.sender === null ? {} : { sender: row.sender }),
        content: row.content,
        status: row.status,
        ...(row.request === undefined ? {} : { request: row.request }),
        ...(row.peerItem === undefined ? {} : { peerItem: row.peerItem }),
      },
    })

  const linkTask = (sessionId: string, execution: number, at: number) =>
    Effect.gen(function* () {
      const [task] = yield* sql<{ id: number }>`SELECT id FROM inbox WHERE session_id = ${sessionId}
        AND kind = 'task' AND status = 'delivered' AND execution_id IS NULL`
      if (task !== undefined)
        yield* emit(InboxMoved, { sessionId, at, data: { inbox: task.id, to: "delivered", execution } })
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
      yield* sessionLive.dropIntegration(id)
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
        yield* placeProcess(id, start.terminal, start.pid, at)
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
      yield* sessionLive.dropIntegration(id)
      return seq
    })

  const placeProcess = (id: string, terminal: string, pid?: number, at?: number) =>
    Effect.gen(function* () {
      const live = yield* liveProcess(id)
      if (live === undefined || live.terminal !== null) return undefined
      yield* emit(ProcessPlaced, {
        sessionId: id,
        ...(at === undefined ? {} : { at }),
        data: { process: live.id, terminal, ...(pid === undefined ? {} : { pid }) },
      })
      return live.id
    })

  const rename = (id: string, name: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ name: string }>`SELECT name FROM session WHERE id = ${id}`
      if (row === undefined || row.name === name) return false
      yield* emit(SessionRenamed, { sessionId: id, data: { name } })
      yield* notify({ type: "live.session", sessionId: id })
      return true
    })

  const archive = (id: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ endedAt: number | null }>`SELECT ended_at FROM session WHERE id = ${id}`
      if (row === undefined || row.endedAt !== null) return false
      yield* emit(SessionEnded, { sessionId: id, data: { reason: "archived" } })
      yield* sessionLive.ended(id)
      yield* notify({ type: "live.session", sessionId: id })
      return true
    })

  const noteConversation = (id: string, conversation: string, process?: number) =>
    Effect.gen(function* () {
      const current = yield* currentProcess(id)
      if (current === undefined || current.conversation === conversation) return false
      if (process !== undefined && process !== current.id) return false
      yield* emit(ProcessConversation, { sessionId: id, data: { process: current.id, conversation } })
      return true
    })

  const endExecution = (id: string, end: ExecutionEnd, at?: number) =>
    Effect.gen(function* () {
      const t = at ?? (yield* now)
      const execution = (yield* openExecution(id)) ?? (yield* startExecution(id, t))
      yield* emit(ExecutionEnded, {
        sessionId: id,
        at: t,
        data: {
          execution,
          outcome: end.outcome,
          ...(end.failure === undefined ? {} : { failure: end.failure }),
          ...(end.conversation === undefined ? {} : { conversation: end.conversation }),
          ...(end.reply === undefined ? {} : { reply: end.reply }),
        },
      })
      return execution
    })

  const origins = (sessionId: string) =>
    sql<{
      peer: string | null
      project: string | null
      session: string | null
    }>`SELECT origin_peer AS peer, origin_project AS project, origin_session AS session
      FROM session WHERE id = ${sessionId}`.pipe(Effect.map((rows) => rows[0]))

  const queueForPeer = (
    peer: string,
    recipientSession: string | null,
    row: {
      readonly sessionId: string
      readonly content: string
      readonly kind: "send" | "notice"
      readonly at?: number
    },
  ) =>
    Effect.gen(function* () {
      if (recipientSession === null) return false
      if ((yield* sql`SELECT 1 FROM peer WHERE id = ${peer}`).length === 0) return false
      yield* emit(OutboxQueued, {
        ...(row.at === undefined ? {} : { at: row.at }),
        data: {
          id: randomId(),
          peer,
          session: row.sessionId,
          recipient: recipientSession,
          kind: row.kind,
          content: row.content,
        },
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

  const renderedSend = (sender: string | undefined, message: string) =>
    Effect.gen(function* () {
      if (sender === undefined) return message
      const [from] = yield* sql<{ name: string }>`SELECT name FROM session WHERE id = ${sender}`
      return sessionEnvelope({ id: sender, title: from?.name }, message)
    })

  const queueSend = (recipient: string, sender: string | undefined, message: string, request?: string) =>
    Effect.gen(function* () {
      const id = yield* queueInbox({
        recipient,
        kind: "send",
        sender: sender ?? null,
        content: yield* renderedSend(sender, message),
        status: "pending",
        request,
      })
      return (yield* inboxIn(recipient, [id]))[0]!
    })

  const noticeTo = (recipient: string, content: string) =>
    Effect.gen(function* () {
      if (!(yield* liveRecipient(recipient))) return false
      yield* queueInbox({
        recipient,
        kind: "notice",
        sender: null,
        content: noticeEnvelope(content),
        status: "pending",
      })
      return true
    })

  const insertInboxRow = (row: NewInboxRow, at?: number) =>
    Effect.gen(function* () {
      const heir = yield* nearestAlive(row.sessionId)
      if (heir === undefined) return undefined
      const insert = (recipient: string, status: "pending" | "dropped") =>
        queueInbox({
          recipient,
          kind: "notice",
          sender: row.sessionId,
          content: noticeEnvelope(row.message),
          status,
          at,
        }).pipe(Effect.flatMap((id) => inboxIn(recipient, [id])))
      if ("peer" in heir) {
        const [queued] = yield* insert(row.sessionId, "dropped")
        yield* queueForPeer(heir.peer, heir.session, {
          sessionId: row.sessionId,
          content: row.message,
          kind: "notice",
          ...(at === undefined ? {} : { at }),
        })
        return queued!
      }
      const [route] = yield* sql<{ project: string; entry: string | null }>`SELECT
          s.project_id AS project, p.entry_session_id AS entry
        FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ${heir.local}`
      const present = route?.entry !== heir.local || placed(route.project, yield* currentProcess(heir.local))
      const [queued] = yield* insert(heir.local, present ? "pending" : "dropped")
      return queued!
    })

  const tellSender = (sender: string, content: string) =>
    Effect.gen(function* () {
      if ((yield* sql`SELECT 1 FROM session WHERE id = ${sender}`).length === 0) return
      if (yield* noticeTo(sender, content)) return
      yield* insertInboxRow({ sessionId: sender, message: content })
    })

  const tellSendersOf = (keys: ReadonlyArray<InboxKey>, reason: string) =>
    Effect.gen(function* () {
      if (keys.length === 0) return
      const sends = yield* sql<{
        sender: string
        recipient: string
        content: string
      }>`SELECT sender_session_id AS sender, session_id AS recipient, content FROM inbox
        WHERE (${keysIn(keys)}) AND kind = 'send' AND sender_session_id IS NOT NULL ORDER BY session_id, id`
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
      yield* remember(next)
      yield* notify({ type: "live.session", sessionId: id })
      if (patch.name !== undefined && patch.name !== current.name) yield* rename(id, patch.name)
      const ending = !!(next.metadata.archived || next.metadata.removed)
      if (ending && !(current.metadata.archived || current.metadata.removed)) yield* archive(id)
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
      } else if (patch.harnessSessionId !== undefined && patch.harnessSessionId !== null)
        yield* noteConversation(id, patch.harnessSessionId)
      if (patch.exitedAt !== undefined && patch.exitedAt !== null && current.exitedAt === null)
        yield* endProcess(id, patch.end ?? "exited", patch.exitedAt)
      if (patch.executionState === "open") {
        if ((yield* openExecution(id)) === undefined)
          yield* startExecution(id, next.executionPromptedAt || (yield* now))
      } else if (
        patch.executionState !== undefined &&
        patch.executionState !== "none" &&
        current.executionState === "open"
      ) {
        const open = yield* openExecution(id)
        if (open !== undefined) {
          yield* emit(ExecutionEnded, { sessionId: id, data: { execution: open, outcome: patch.executionState } })
        }
      }
    })

  const setStatus = (id: string, status: AgentStatus) =>
    Effect.gen(function* () {
      const current = yield* findSession(id)
      if (current === undefined) return
      yield* remember({ ...current, status })
      yield* notify({ type: "live.session", sessionId: id })
    })

  const dropWaiting = (projectIdValue: string) =>
    Effect.gen(function* () {
      const dropped = yield* moveInbox(sql`status = 'pending' AND session_id = ${entryIdOf(projectIdValue)}`, "dropped")
      yield* tellSendersOf(dropped, "the entry session is not running")
    })

  const sessionAt = (runtime: string, address: RuntimeAddress) =>
    sql<{ id: string }>`SELECT s.id FROM session s JOIN process p ON p.session_id = s.id AND p.id = s.process_id
      WHERE p.runtime = ${runtime} AND p.terminal = ${address.id} AND p.ended_at IS NULL
      ORDER BY s.created_at, s.id
      LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.id))

  const entrySessionsAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string; project: string }>`SELECT s.id, s.project_id AS project FROM session s
        JOIN project q ON q.entry_session_id = s.id
        JOIN process p ON p.session_id = s.id AND p.id = s.process_id
        WHERE p.runtime = ${runtime} AND p.terminal = ${address.id} AND p.ended_at IS NULL
          ${except === undefined ? sql`` : sql`AND s.project_id != ${except}`}`
      return rows.filter((r) => !moving.has(r.project))
    })

  const clearEntryAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    Effect.gen(function* () {
      for (const entry of yield* entrySessionsAt(runtime, address, except)) {
        yield* endProcess(entry.id, "exited")
        yield* dropWaiting(entry.project)
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

  type Creator = { readonly local: string } | { readonly peer: string; readonly session: string } | undefined
  const creatorOf = (id: string): Effect.Effect<Creator> =>
    sql<{ parent: string | null; peer: string | null; session: string | null }>`SELECT
        parent_session_id AS parent, origin_peer AS peer, origin_session AS session
      FROM session WHERE id = ${id}`.pipe(
      Effect.map(([row]): Creator => {
        if (row === undefined) return undefined
        if (row.peer !== null && row.session !== null) return { peer: row.peer, session: row.session }
        if (row.parent !== null) return { local: row.parent }
        return undefined
      }),
      Effect.orDie,
    )

  const nearestAlive = (id: string): Effect.Effect<Creator> =>
    Effect.gen(function* () {
      let current = id
      for (;;) {
        const creator = yield* creatorOf(current)
        if (creator === undefined || "peer" in creator) return creator
        if ((yield* sql`SELECT 1 FROM session WHERE id = ${creator.local} AND ended_at IS NULL`).length > 0)
          return creator
        current = creator.local
      }
    }).pipe(Effect.orDie)

  return {
    sql,
    reads,
    placeProcess,
    rename,
    archive,
    noteConversation,
    creatorOf,
    nearestAlive,
    now,
    sessionLive,
    moving,
    remember,
    emit,
    tx,
    notify,
    projectPrefixTaken,
    repositoriesOf,
    changedRepositories,
    running,
    selectRaw,
    selectSessions,
    findSession,
    currentProcess,
    currentProcessId,
    findEntrySessions,
    inbox,
    inboxIn,
    findSend,
    openExecution,
    startExecution,
    moveInbox,
    queueInbox,
    queueSend,
    noticeTo,
    tellSender,
    liveRecipient,
    queueForPeer,
    origins,
    linkTask,
    endProcess,
    startProcess,
    endExecution,
    insertInboxRow,
    updateSession,
    setStatus,
    dropWaiting,
    sessionAt,
    entrySessionsAt,
    clearEntryAt,
    unusedId,
    conversationOf,
    placed,
  }
})

export type Store = Effect.Success<typeof makeStore>
