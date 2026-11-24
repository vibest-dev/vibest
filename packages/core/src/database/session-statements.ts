import {
  ExecutionAllocated,
  ExecutionFailed,
  ExecutionInput,
  ExecutionInterrupted,
  ExecutionStarted,
  ExecutionSucceeded,
  ExecutionUnresolved,
  type ExecutionFailure,
  type ExecutionObservation,
  ProcessConversation,
  ProcessEnded,
  type ProcessEndReason,
  type Sender,
  ProcessPlaced,
  ProcessStarted,
  SessionEnded,
  SessionRenamed,
} from "@vibest/schema/event"
import { newId, sessionLabel } from "@vibest/schema/id"
import { Routing } from "@vibest/schema/plugin"
import { type AgentStatus, RuntimeAddress } from "@vibest/schema/session"
import { Effect, Schema } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { Bus } from "../bus.ts"
import { SessionLive } from "../session/live.ts"
import { archived, SessionRow, type ProcessStart, type Integration, type ExecutionEnd } from "./db-rows.ts"
import { decodeSessions, ledgerReads, sessionOf } from "./ledger-read.ts"

export type Current = {
  readonly id: number
  readonly start: ProcessStart
  readonly ended: number | null
  readonly terminal: string | null
  readonly harnessSessionId: string | null
  readonly integration: Integration | undefined
  readonly readyAt: number | null
}

export type Creator = { readonly local: string } | { readonly remote: string; readonly session: string } | undefined

type ProcessColumns = {
  readonly id: number
  readonly harness: string
  readonly provider: string | null
  readonly model: string | null
  readonly routing: string | null
  readonly runtime: string
  readonly terminal: string | null
  readonly pid: number | null
  readonly harnessSessionId: string | null
  readonly integrationVersion: string | null
  readonly integrationProtocol: number | null
  readonly readyAt: number | null
  readonly endedAt: number | null
}

const encodeRouting = Schema.encodeSync(Routing)

const decodeRoutingJson = Schema.decodeSync(Schema.fromJsonString(Routing))

const routingJson = (routing: Routing | undefined) =>
  routing === undefined ? null : JSON.stringify(encodeRouting(routing))

const currentOf = (row: ProcessColumns): Current => ({
  id: row.id,
  start: {
    harness: row.harness,
    ...(row.provider !== null && { provider: row.provider }),
    ...(row.model !== null && { model: row.model }),
    ...(row.routing !== null && { routing: decodeRoutingJson(row.routing) }),
    runtime: row.runtime,
    terminal: row.terminal ?? "",
    ...(row.pid !== null && { pid: row.pid }),
  },
  ended: row.endedAt,
  terminal: row.terminal,
  harnessSessionId: row.harnessSessionId,
  integration:
    row.integrationVersion === null || row.integrationProtocol === null
      ? undefined
      : { version: row.integrationVersion, protocol: row.integrationProtocol },
  readyAt: row.readyAt,
})

const PROCESS_COLUMNS = `id, harness, provider, model, routing, runtime, terminal, pid, harness_session_id,
  integration_version, integration_protocol, ready_at, ended_at`

export const statements = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const bus = yield* Bus.Service
  const sessionLive = yield* SessionLive.Service
  const { publish, observe } = bus
  const afterCommitLive = (effect: Effect.Effect<void>) => bus.afterCommit(() => Effect.runSync(effect))
  const reads = ledgerReads(sql)
  const moving = new Set<string>()

  const remember = (row: Pick<SessionRow, "id" | "status" | "entry" | "endedAt">) =>
    archived(row) ? sessionLive.ended(row.id) : sessionLive.setStatus(row.id, row.status)

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
    selectSessions(project === undefined ? [] : [sql`s.project_id = ${project}`], sql`entry = 1`).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          moving.has(row.projectId) && row.process !== null
            ? { ...row, process: { ...row.process, terminal: null } }
            : row,
        ),
      ),
    )

  const openExecution = (sessionId: string) =>
    sql<{ id: number }>`SELECT id FROM execution WHERE session_id = ${sessionId} AND owner = 1`.pipe(
      Effect.map((rows) => rows[0]?.id),
    )

  const workingExecutions = sql<{
    n: number
  }>`SELECT count(*) AS n FROM execution e JOIN session s ON s.id = e.session_id
      WHERE e.owner = 1 AND s.ended_at IS NULL`.pipe(Effect.map((rows) => rows[0]?.n ?? 0))

  const currentProcessId = (sessionId: string) =>
    sql<{ id: number | null }>`SELECT process_id AS id FROM session WHERE id = ${sessionId}`.pipe(
      Effect.map((rows) => rows[0]?.id ?? undefined),
    )

  const nextExecutionId = (sessionId: string) =>
    sql<{ id: number }>`SELECT coalesce(max(id), 0) + 1 AS id FROM execution WHERE session_id = ${sessionId}`.pipe(
      Effect.map((rows) => rows[0]?.id ?? 1),
    )

  const executionOutcome = (sessionId: string, execution: number) =>
    sql<{ outcome: string | null; started: number | null; booked: number; process: number | null }>`SELECT
        outcome, started_at AS started, booked_at AS booked, process_id AS process FROM execution
      WHERE session_id = ${sessionId} AND id = ${execution}`.pipe(Effect.map((rows) => rows[0]))

  const allocateExecution = (sessionId: string, at: number, typed?: string) =>
    Effect.gen(function* () {
      const executionId = yield* nextExecutionId(sessionId)
      const process = yield* currentProcessId(sessionId)
      yield* publish(ExecutionAllocated, {
        sessionId,
        at,
        data: {
          executionId,
          ...(process !== undefined && { processId: process }),
          ...(typed !== undefined && typed !== "" && { typed }),
        },
      })

      return executionId
    })

  const startedAt = (id: string, execution: number) =>
    sql<{ at: number | null }>`SELECT started_at AS at FROM execution
      WHERE session_id = ${id} AND id = ${execution}`.pipe(Effect.map((rows) => rows[0]?.at ?? null))

  const accept = (id: string, execution: number) =>
    Effect.gen(function* () {
      if ((yield* openExecution(id)) !== execution) return false

      if ((yield* startedAt(id, execution)) !== null) return true
      const process = yield* currentProcessId(id)
      yield* publish(ExecutionStarted, {
        sessionId: id,
        data: { executionId: execution, ...(process !== undefined && { processId: process }) },
      })

      return true
    })

  const finishable = (outcome: string | null | undefined) =>
    outcome === undefined || outcome === null || outcome === "lost" || outcome === "not_started"

  const releaseExecution = (sessionId: string, execution: number, observation: ExecutionObservation, at?: number) =>
    Effect.gen(function* () {
      const row = yield* executionOutcome(sessionId, execution)

      if (row === undefined || row.outcome !== null) return false
      yield* publish(ExecutionUnresolved, {
        sessionId,
        ...(at !== undefined && { at }),
        data: { executionId: execution, observation },
      })

      return true
    })

  const observable = (id: string) =>
    sql<{ ok: number }>`SELECT 1 AS ok FROM session s WHERE s.id = ${id} AND s.ended_at IS NULL`.pipe(
      Effect.map((rows) => rows.length > 0),
    )

  const isEntry = (id: string) =>
    sql`SELECT 1 FROM project WHERE entry_session_id = ${id}`.pipe(Effect.map((rows) => rows.length > 0))

  const fromOldProcess = (id: string, process: number | undefined) =>
    Effect.map(currentProcessId(id), (current) => process !== undefined && process !== current)

  const endProcess = (id: string, reason: ProcessEndReason, at?: number, process?: number, by?: Sender) =>
    Effect.gen(function* () {
      const current = yield* currentProcess(id)

      if (current === undefined || current.ended !== null || (process !== undefined && process !== current.id))
        return false

      if (reason === "launch_failed") {
        const execution = yield* openExecution(id)
        const open = execution === undefined ? undefined : yield* executionOutcome(id, execution)

        if (execution !== undefined && open?.process === current.id && open.started === null)
          yield* releaseExecution(id, execution, "not_started", at)
      }

      yield* publish(ProcessEnded, {
        sessionId: id,
        ...(at !== undefined && { at }),
        data: { process: current.id, reason, ...(by !== undefined && { by }) },
      })
      yield* afterCommitLive(sessionLive.forgetProcess(id))

      return true
    })

  const sameChoice = (live: Current, start: ProcessStart) =>
    live.start.harness === start.harness &&
    live.start.provider === start.provider &&
    live.start.model === start.model &&
    live.start.runtime === start.runtime &&
    routingJson(live.start.routing) === routingJson(start.routing)

  const placeProcess = (id: string, terminal: string, pid?: number, at?: number) =>
    Effect.gen(function* () {
      const live = yield* liveProcess(id)

      if (live === undefined || live.terminal !== null) return undefined
      yield* publish(ProcessPlaced, {
        sessionId: id,
        ...(at !== undefined && { at }),
        data: { process: live.id, terminal, ...(pid !== undefined && { pid }) },
      })

      return live.id
    })

  const startProcess = (id: string, start: ProcessStart, at?: number) =>
    Effect.gen(function* () {
      const live = yield* liveProcess(id)
      const stamp = at === undefined ? {} : { at }

      if (live !== undefined && live.terminal === null && start.terminal !== "" && sameChoice(live, start)) {
        yield* placeProcess(id, start.terminal, start.pid, at)

        if (start.resume && start.resume !== live.harnessSessionId)
          yield* publish(ProcessConversation, {
            sessionId: id,
            ...stamp,
            data: { process: live.id, conversation: start.resume },
          })

        return live.id
      }

      if (live !== undefined)
        yield* publish(ProcessEnded, { sessionId: id, ...stamp, data: { process: live.id, reason: "superseded" } })

      const seq = yield* publish(ProcessStarted, {
        sessionId: id,
        ...stamp,
        data: {
          harness: start.harness,
          ...(start.provider && { provider: start.provider }),
          ...(start.model && { model: start.model }),
          ...(start.routing !== undefined && { routing: start.routing }),
          ...(start.resume && { resume: start.resume }),
          runtime: start.runtime,
          ...(start.terminal !== "" && { terminal: start.terminal }),
          ...(start.pid !== undefined && { pid: start.pid }),
        },
      })

      yield* afterCommitLive(sessionLive.forgetProcess(id))

      return seq
    })

  const ensureProcess = (id: string, start: ProcessStart) =>
    Effect.gen(function* () {
      const live = yield* liveProcess(id)

      if (live !== undefined && live.terminal === null && sameChoice(live, start)) {
        if (start.resume && start.resume !== live.harnessSessionId)
          yield* publish(ProcessConversation, { sessionId: id, data: { process: live.id, conversation: start.resume } })

        return live.id
      }

      return yield* startProcess(id, start)
    })

  const rename = (id: string, name: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ name: string }>`SELECT name FROM session WHERE id = ${id}`

      if (row === undefined || row.name === name) return false
      yield* publish(SessionRenamed, { sessionId: id, data: { name } })

      return true
    })

  const labelOf = (id: string) =>
    sql<{ name: string }>`SELECT name FROM session WHERE id = ${id}`.pipe(
      Effect.map(([row]) => sessionLabel({ id, name: row?.name ?? "" })),
    )

  const archive = (id: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ endedAt: number | null }>`SELECT ended_at FROM session WHERE id = ${id}`

      if (row === undefined || row.endedAt !== null) return false
      yield* publish(SessionEnded, { sessionId: id, data: { reason: "archived" } })
      yield* afterCommitLive(sessionLive.ended(id))

      return true
    })

  const noteConversation = (id: string, conversation: string, process?: number) =>
    Effect.gen(function* () {
      const current = yield* currentProcess(id)

      if (current === undefined || current.harnessSessionId === conversation) return false

      if (process !== undefined && process !== current.id) return false
      yield* publish(ProcessConversation, { sessionId: id, data: { process: current.id, conversation } })

      return true
    })

  const finishExecution = (id: string, execution: number, end: ExecutionEnd, at?: number) =>
    Effect.gen(function* () {
      const row = yield* executionOutcome(id, execution)

      if (row === undefined || !finishable(row.outcome)) return false
      const stamp = at === undefined ? {} : { at }
      const reply = end.reply

      if (end.outcome === "completed")
        yield* publish(ExecutionSucceeded, {
          sessionId: id,
          ...stamp,
          data: { executionId: execution, ...(reply !== undefined && { reply }) },
        })
      else if (end.outcome === "failed") {
        const failure: ExecutionFailure = end.failure ?? { message: "failed" }
        yield* publish(ExecutionFailed, {
          sessionId: id,
          ...stamp,
          data: { executionId: execution, failure, ...(reply !== undefined && { reply }) },
        })
      } else if (end.outcome === "interrupted")
        yield* publish(ExecutionInterrupted, {
          sessionId: id,
          ...stamp,
          data: {
            executionId: execution,
            ...(end.failure !== undefined && { reason: end.failure.message }),
            ...(reply !== undefined && { reply }),
          },
        })
      else {
        const observation: ExecutionObservation = end.outcome === "not_started" ? "not_started" : "lost"
        yield* publish(ExecutionUnresolved, {
          sessionId: id,
          ...stamp,
          data: {
            executionId: execution,
            observation,
            ...(end.failure !== undefined && { failure: end.failure }),
            ...(reply !== undefined && { reply }),
          },
        })
      }

      return true
    })

  const noteInput = (sessionId: string, execution: number, typed: string) =>
    publish(ExecutionInput, { sessionId, data: { executionId: execution, typed } })

  const confirmedOutcome = (outcome: string | null) =>
    outcome === "completed" || outcome === "failed" || outcome === "interrupted"

  const recordObservedEnd = (
    id: string,
    end: ExecutionEnd,
    at: number | undefined,
    currentProcess: number,
    executionId?: number,
    needsReady = false,
    pulls = false,
  ) =>
    Effect.gen(function* () {
      if (executionId !== undefined) {
        const rows = yield* sql<{
          id: number
          outcome: string | null
          owner: number
        }>`SELECT id, outcome, owner FROM execution WHERE session_id = ${id}`

        const named = rows.find((row) => row.id === executionId)

        if (named === undefined) return undefined

        if (confirmedOutcome(named.outcome))
          return { kind: "duplicate" as const, id: named.id, active: rows.some((row) => row.owner === 1) }
        const wrote = yield* finishExecution(id, named.id, end, at)

        return {
          kind: "settled" as const,
          id: named.id,
          current: rows.some((row) => row.owner === 1 && row.id === named.id),
          wrote,
        }
      }

      const rows = yield* sql<{
        id: number
        outcome: string | null
        owner: number
        reply: string | null
        started: number | null
        typed: string | null
      }>`SELECT id, outcome, owner, reply, started_at AS started, typed FROM execution
        WHERE session_id = ${id} AND process_id = ${currentProcess} ORDER BY id`

      const active = rows.find((row) => row.owner === 1)
      const reply = end.reply ?? null

      if (active === undefined) {
        const last = rows.at(-1)

        if (
          last !== undefined &&
          confirmedOutcome(last.outcome) &&
          last.outcome === end.outcome &&
          reply !== null &&
          reply !== "" &&
          last.reply === reply
        )
          return { kind: "duplicate" as const, id: last.id, active: false }

        return { kind: "unmatched" as const }
      }

      const unresolvedEarlier = rows.some((row) => row.id !== active.id && !confirmedOutcome(row.outcome))

      if (unresolvedEarlier) return { kind: "unmatched" as const }

      if (active.started === null && active.typed === null) {
        if (needsReady) return { kind: "unaccepted" as const }

        if (pulls) {
          const unacceptedPulled =
            (yield* sql<{ ok: number }>`SELECT 1 AS ok FROM inbox m
              WHERE m.recipient_session_id = ${id} AND m.status = 'delivering'
                AND m.recipient_execution_id = ${active.id}
                AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.recipient_session_id AND s.message_id = m.id)
              LIMIT 1`).length > 0

          if (unacceptedPulled) return { kind: "unaccepted" as const }
        }
      }

      const wrote = yield* finishExecution(id, active.id, end, at)

      return { kind: "settled" as const, id: active.id, current: true, wrote }
    })

  const setStatus = (id: string, status: AgentStatus) =>
    Effect.gen(function* () {
      const current = yield* findSession(id)

      if (current === undefined) return
      yield* afterCommitLive(remember({ ...current, status }))
      yield* observe({ type: "session.changed", sessionId: id })
    })

  const processesAt = (runtime: string, address: RuntimeAddress) =>
    sql<{ sessionId: string; process: number }>`SELECT s.id AS session_id, p.id AS process FROM session s
      JOIN process p ON p.session_id = s.id AND p.id = s.process_id
      WHERE p.runtime = ${runtime} AND p.terminal = ${address.id} AND p.ended_at IS NULL`

  const lastSessionAt = (runtime: string, address: RuntimeAddress) =>
    sql<{ sessionId: string }>`SELECT session_id FROM process WHERE runtime = ${runtime} AND terminal = ${address.id}
      ORDER BY started_at DESC, rowid DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.sessionId))

  const lastProjectTerminal = (projectId: string, runtime: string) =>
    sql<{ terminal: string }>`SELECT p.terminal FROM process p
      JOIN session s ON s.id = p.session_id
      WHERE s.project_id = ${projectId}
        AND s.origin_remote IS NULL
        AND p.runtime = ${runtime}
        AND p.terminal IS NOT NULL
        AND p.terminal != ''
      ORDER BY p.ended_at IS NOT NULL, p.started_at DESC, p.rowid DESC
      LIMIT 1`.pipe(
      Effect.map((rows): RuntimeAddress | undefined =>
        rows[0] === undefined ? undefined : { machine: "local", id: rows[0].terminal },
      ),
    )

  const entrySessionsAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string; project: string }>`SELECT s.id, s.project_id AS project FROM session s
        JOIN project q ON q.entry_session_id = s.id
        JOIN process p ON p.session_id = s.id AND p.id = s.process_id
        WHERE p.runtime = ${runtime} AND p.terminal = ${address.id} AND p.ended_at IS NULL
          ${except === undefined ? sql`` : sql`AND s.project_id != ${except}`}`

      return rows.filter((r) => !moving.has(r.project))
    })

  const sessionPrefixTaken = (short: string) =>
    sql`SELECT 1 FROM session WHERE id >= ${short} AND id < ${`${short}~`} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )

  const unusedId = newId(sessionPrefixTaken)

  const creatorOf = (id: string): Effect.Effect<Creator> =>
    sql<{ parent: string | null; remote: string | null; session: string | null }>`SELECT
        parent_session_id AS parent, origin_remote AS remote, origin_session AS session
      FROM session WHERE id = ${id}`.pipe(
      Effect.map(([row]): Creator => {
        if (row === undefined) return undefined

        if (row.remote !== null && row.session !== null) return { remote: row.remote, session: row.session }

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

        if (creator === undefined || "remote" in creator) return creator

        if ((yield* sql`SELECT 1 FROM session WHERE id = ${creator.local} AND ended_at IS NULL`).length > 0)
          return creator
        current = creator.local
      }
    }).pipe(Effect.orDie)

  const fromCurrentHarness = (sessionId: string, current: number, reporter?: number, pid?: number) =>
    Effect.gen(function* () {
      const processes = yield* sql<{
        id: number
        pid: number | null
        terminal: string | null
      }>`SELECT id, pid, terminal FROM process WHERE session_id = ${sessionId}`

      if (pid !== undefined && processes.some((p) => p.id !== current && p.pid === pid)) return false

      if (reporter === undefined || reporter === current) return true
      const terminalOf = (id: number) => processes.find((p) => p.id === id)?.terminal ?? null

      return pid !== undefined && terminalOf(reporter) !== null && terminalOf(reporter) === terminalOf(current)
    })

  const canResumeConversation = (sessionId: string, harnessSessionId: string) =>
    sql<{ ok: number }>`SELECT (
      EXISTS (
        SELECT 1 FROM execution t JOIN process p ON p.session_id = t.session_id AND p.id = t.process_id
        WHERE t.session_id = ${sessionId} AND (t.started_at IS NOT NULL OR t.outcome IS NOT NULL)
          AND p.harness_session_id = ${harnessSessionId}
      )
      OR (
        EXISTS (SELECT 1 FROM project WHERE entry_session_id = ${sessionId})
        AND EXISTS (SELECT 1 FROM process WHERE session_id = ${sessionId} AND harness_session_id = ${harnessSessionId})
      )
    ) AS ok`.pipe(
      Effect.map((rows) => rows[0]?.ok === 1),
      Effect.orDie,
    )

  const latestReply = (sessionId: string) =>
    sql<{
      execution: number
      status: string
      text: string | null
      failure: string | null
      endedAt: number
    }>`SELECT id AS execution, outcome AS status, reply AS text, failure, ended_at FROM execution
      WHERE session_id = ${sessionId} AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    )

  return {
    reads,
    afterCommitLive,
    moving,
    running,
    selectRaw,
    selectSessions,
    findSession,
    currentProcess,
    currentProcessId,
    placed,
    findEntrySessions,
    openExecution,
    workingExecutions,
    allocateExecution,
    noteInput,
    startedAt,
    releaseExecution,
    finishExecution,
    recordObservedEnd,
    accept,
    observable,
    isEntry,
    fromOldProcess,
    endProcess,
    placeProcess,
    startProcess,
    ensureProcess,
    rename,
    labelOf,
    archive,
    noteConversation,
    setStatus,
    entrySessionsAt,
    processesAt,
    lastSessionAt,
    lastProjectTerminal,
    unusedId,
    creatorOf,
    nearestAlive,
    fromCurrentHarness,
    canResumeConversation,
    latestReply,
  }
})

export type Statements = Effect.Success<typeof statements>
