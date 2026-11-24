import {
  ProcessEnded,
  type ProcessEndReason,
  ProcessPid,
  ProcessReady,
  SessionCreated,
  SessionDirectoryChanged,
  SessionLinked,
  type Sender,
} from "@vibest/schema/event"
import { entryLabel } from "@vibest/schema/id"
import type { Routing } from "@vibest/schema/plugin"
import {
  type AgentStatus,
  AmbiguousSession,
  type ExecutionState,
  NoSuchSession,
  RuntimeAddress,
  type HarnessId,
} from "@vibest/schema/session"
import { Clock, Effect, Predicate } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"
import { type ObservedEnd } from "../replies.ts"
import { SessionLive } from "../session/live.ts"
import {
  failureOf,
  limitFailure,
  limitText,
  type ExecutionEnd,
  type ExecutionFailure,
  type Integration,
  type NewSession,
  type ProcessStart,
  type SpawnedBefore,
} from "./db-rows.ts"
import type * as Inbox from "./inbox.ts"
import type * as Remote from "./remote.ts"
import * as SessionEdges from "./session-edges.ts"
import type { SpawnLinks } from "./session-edges.ts"
import type * as Session from "./session-statements.ts"

export type { SessionEdge, SpawnLinks } from "./session-edges.ts"

export const LIVE_PROCESS_COUNT = "SELECT count(*) AS n FROM process WHERE ended_at IS NULL"

export type SessionFilter = {
  readonly projectId?: string
  readonly stopped?: boolean
  readonly unarchived?: boolean
  readonly remote?: Remote.RemoteScope | undefined
  readonly waiting?: ReadonlyArray<string>
}

export const make = (session: Session.Statements, inbox: Inbox.Statements, remote: Remote.Statements) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { publish, afterCommit, transaction: tx } = yield* Bus.Service
    const sessionLive = yield* SessionLive.Service
    const now = Clock.currentTimeMillis

    const {
      reads,
      afterCommitLive,
      moving,
      running,
      selectSessions,
      findSession,
      currentProcess,
      currentProcessId,
      latestRoot,
      openExecution,
      workingExecutions,
      allocateExecution,
      noteInput,
      startedAt,
      accept,
      observable,
      isRoot,
      fromOldProcess,
      endProcess,
      startProcess,
      ensureProcess,
      releaseExecution,
      finishExecution,
      recordObservedEnd,
      setStatus,
      liveSessionsAt,
      unusedId,
      creatorOf,
      fromCurrentHarness,
      canResumeConversation,
    } = session

    const { queueInbox, insertInboxRow } = inbox

    const roomFor = (max: number | undefined) =>
      max === undefined
        ? Effect.succeed(true)
        : sql.unsafe<{ n: number }>(LIVE_PROCESS_COUNT).pipe(Effect.map((rows) => (rows[0]?.n ?? 0) < max))

    const clearAt = (runtime: string, address: RuntimeAddress, except?: string) =>
      Effect.gen(function* () {
        for (const other of yield* liveSessionsAt(runtime, address, except)) {
          yield* endProcess(other.id, "exited")
        }
      })

    const edges = yield* SessionEdges.make

    return {
      ...edges,

      sessionDirectory: Effect.fn("Db.session.sessionDirectory")((id: string) =>
        sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows[0]?.directory),
          Effect.orDie,
        ),
      ),

      worktreeSessions: Effect.fn("Db.session.worktreeSessions")(() =>
        sql<{
          id: string
          projectId: string
          name: string
          directory: string
          endedAt: number | null
        }>`SELECT id, project_id, name, directory, ended_at FROM session WHERE directory != ''`.pipe(Effect.orDie),
      ),

      startedByRemote: Effect.fn("Db.session.startedByRemote")((id: string) =>
        sql`SELECT 1 FROM session WHERE id = ${id} AND origin_remote IS NOT NULL`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      ),

      hadTerminal: Effect.fn("Db.session.hadTerminal")((id: string) => reads.hadTerminal(id).pipe(Effect.orDie)),

      liveSharers: Effect.fn("Db.session.liveSharers")((id: string) =>
        sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
          WHERE o.id != s.id AND o.directory = s.directory AND s.directory != '' AND o.ended_at IS NULL
          ORDER BY o.id`.pipe(
          Effect.map((rows) => rows.map((r) => r.id)),
          Effect.orDie,
        ),
      ),

      earlierSharer: Effect.fn("Db.session.earlierSharer")((id: string) =>
        sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
          WHERE o.id != s.id AND o.directory = s.directory AND s.directory != ''
            AND (o.created_at, o.rowid) < (s.created_at, s.rowid)
          ORDER BY o.created_at, o.rowid LIMIT 1`.pipe(
          Effect.map((rows) => rows[0]?.id),
          Effect.orDie,
        ),
      ),

      creatorOf,

      nearestAlive: session.nearestAlive,

      creatorLabel: Effect.fn("Db.session.creatorLabel")((id: string) =>
        Effect.gen(function* () {
          const creator = yield* creatorOf(id)

          if (creator === undefined) return undefined

          if ("remote" in creator)
            return { id: creator.session, label: "the agent that started you", remote: creator.remote }

          const [row] = yield* sql<{ name: string | null }>`SELECT name FROM session WHERE id = ${creator.local}`

          const label = row?.name ? `agent ${row.name}` : "the agent that started you"

          return { id: creator.local, label, remote: undefined }
        }).pipe(Effect.orDie),
      ),

      insertSession: Effect.fn("Db.session.insertSession")(
        (
          row: Omit<NewSession, "projectId">,
          project: string,
          {
            cwd = "",
            task,
            parentSessionId,
            request,
            origin,
            max,
            links,
          }: {
            readonly cwd?: string
            readonly task?: string
            readonly parentSessionId?: string | undefined
            readonly request?: string | undefined
            readonly origin?: Remote.RemoteStart | undefined
            readonly max?: number | undefined
            readonly links?: SpawnLinks | undefined
          } = {},
        ): Effect.Effect<true | "waiting" | SpawnedBefore | "parent-ended"> =>
          tx(
            Effect.gen(function* () {
              if (request !== undefined) {
                const before = yield* reads.spawnedBy(project, request)

                if (before !== undefined) return before
              }

              if (
                parentSessionId !== undefined &&
                (yield* sql`SELECT 1 FROM session WHERE id = ${parentSessionId} AND ended_at IS NOT NULL`).length > 0
              )
                return "parent-ended" as const

              const message =
                task === undefined
                  ? undefined
                  : yield* queueInbox({
                      recipient: row.id,
                      sender:
                        parentSessionId !== undefined
                          ? {
                              type: "agent",
                              ...((yield* remote.senderOf(parentSessionId)) ?? { session: parentSessionId }),
                            }
                          : origin?.reportTo !== undefined
                            ? {
                                type: "agent",
                                session: origin.reportTo,
                                machine: (yield* remote.remoteName(origin.remote)) ?? origin.remote,
                              }
                            : { type: "user" },
                      content: task,
                      request,
                      at: row.createdAt,
                    })

              yield* publish(SessionCreated, {
                sessionId: row.id,
                at: row.createdAt,
                data: {
                  project,
                  agent: row.agent,
                  name: row.name,
                  directory: cwd,
                  ...(parentSessionId !== undefined && { parent: parentSessionId }),
                  ...(origin !== undefined && {
                    origin: {
                      remote: origin.remote,
                      project: origin.project,
                      ...(origin.reportTo !== undefined && { session: origin.reportTo }),
                    },
                  }),
                  ...(message !== undefined && { message }),
                },
              })

              const seen = new Set<string>()

              const link = (from: string, to: string, remoteId?: string) => {
                if (remoteId === undefined && from === to) return Effect.void
                const key = `${from}\0${remoteId ?? ""}\0${to}`

                if (seen.has(key)) return Effect.void
                seen.add(key)

                return publish(SessionLinked, {
                  sessionId: from,
                  at: row.createdAt,
                  data: { to, ...(remoteId !== undefined && { remote: remoteId }) },
                }).pipe(Effect.asVoid)
              }

              if (parentSessionId !== undefined) {
                yield* link(parentSessionId, row.id)
                yield* link(row.id, parentSessionId)
              }

              if (origin?.reportTo !== undefined) yield* link(row.id, origin.reportTo, origin.remote)

              for (const fromId of links?.from ?? []) yield* link(fromId, row.id)

              for (const toId of links?.to ?? []) yield* link(row.id, toId)

              for (const targetId of links?.with ?? []) {
                yield* link(targetId, row.id)
                yield* link(row.id, targetId)
              }

              const processAt = row.startedAt ?? row.createdAt
              const admitted = yield* roomFor(max)

              const process = !admitted
                ? undefined
                : yield* startProcess(
                    row.id,
                    {
                      harness: row.harnessId,
                      ...(row.provider && { provider: row.provider }),
                      ...(row.model && { model: row.model }),
                      ...(row.routing !== undefined && { routing: row.routing }),
                      runtime: row.runtime,
                      terminal: row.address.id,
                      ...(row.harnessSessionId && { resume: row.harnessSessionId }),
                    },
                    processAt,
                  )

              if (row.exitedAt !== null && process !== undefined)
                yield* publish(ProcessEnded, {
                  sessionId: row.id,
                  at: row.exitedAt,
                  data: { process, reason: "exited" },
                })

              if (row.executionState !== "none") {
                const execution = yield* allocateExecution(row.id, row.executionPromptedAt)
                yield* inbox.linkTask(row.id, execution, row.executionPromptedAt)

                if (row.executionState !== "open")
                  yield* finishExecution(row.id, execution, { outcome: row.executionState }, row.executionPromptedAt)
              }

              yield* afterCommitLive(sessionLive.setStatus(row.id, row.status))

              return admitted ? (true as const) : ("waiting" as const)
            }),
          ).pipe(Effect.orDie),
      ),

      resolveSession: Effect.fn("Db.session.resolveSession")((input: string, scope?: Remote.RemoteScope) =>
        Effect.gen(function* () {
          if (!/^[0-9a-f-]{8,36}$/.test(input))
            return yield* new NoSuchSession({
              id: input,
              message: /^[0-9a-f-]{1,7}$/.test(input)
                ? `${input}: a session id or a prefix of at least 8 of its characters`
                : `no session ${input}`,
            })

          const rows = yield* sql<{
            id: string
          }>`SELECT s.id FROM session s WHERE s.id >= ${input} AND s.id < ${`${input}~`}
            ${scope === undefined ? sql`` : sql`AND ${remote.ofRemote(sql`s.id`, scope)}`} ORDER BY s.id LIMIT 11`.pipe(
            Effect.orDie,
          )

          if (rows.length === 0) return yield* new NoSuchSession({ id: input, message: `no session ${input}` })

          if (rows.length > 1) return yield* new AmbiguousSession({ prefix: input, matches: rows.map((r) => r.id) })

          return rows[0]!.id
        }),
      ),

      newSessionId: unusedId.pipe(Effect.orDie),

      sessionIdentity: Effect.fn("Db.session.sessionIdentity")((id: string) =>
        sql<{
          id: string
          projectId: string
          agent: string
          harness: string
          parentId: string | null
        }>`SELECT a.id, a.project_id, a.agent,
            coalesce(p.harness, '') AS harness,
            a.parent_session_id AS parent_id
          FROM session a
          LEFT JOIN process p ON p.session_id = a.id AND p.id = a.process_id
          WHERE a.id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        ),
      ),

      getSession: Effect.fn("Db.session.getSession")((id: string) => findSession(id).pipe(Effect.orDie)),

      listSessions: Effect.fn("Db.session.listSessions")((filter: SessionFilter = {}) =>
        selectSessions(
          [
            ...(filter.projectId === undefined ? [] : [sql`s.project_id = ${filter.projectId}`]),
            ...(filter.unarchived === true ? [sql`s.ended_at IS NULL`] : []),
            ...(filter.remote === undefined ? [] : [remote.ofRemote(sql`s.id`, filter.remote)]),
          ],
          filter.stopped || filter.unarchived
            ? undefined
            : sql`((${running} AND (p_id IS NOT NULL OR ended_at IS NULL)) OR ${
                (filter.waiting ?? []).length === 0 ? sql`0` : sql.in("id", filter.waiting!)
              })`,
        ).pipe(Effect.orDie),
      ),

      sessionBriefs: Effect.fn("Db.session.sessionBriefs")((ids: ReadonlyArray<string>) =>
        reads.briefs(ids).pipe(Effect.orDie),
      ),

      allocateSessionId: Effect.fn("Db.session.allocateSessionId")(() => unusedId),

      isRoot: Effect.fn("Db.session.isRoot")((id: string) => isRoot(id).pipe(Effect.orDie)),

      latestRoot: Effect.fn("Db.session.latestRoot")((projectIdValue: string) =>
        latestRoot(projectIdValue).pipe(
          Effect.map((row) =>
            row !== undefined && moving.has(row.id) && row.process !== null
              ? { ...row, process: { ...row.process, terminal: null } }
              : row,
          ),
          Effect.orDie,
        ),
      ),

      startRoot: Effect.fn("Db.session.startRoot")(
        (
          project: string,
          harness: HarnessId,
          fresh: boolean,
          location: { readonly runtime: string; readonly address: RuntimeAddress },
          start: {
            readonly provider?: string | undefined
            readonly model?: string | undefined
            readonly routing?: Routing | undefined
            readonly projectDirectory?: string | undefined
            readonly pid?: number | undefined
            readonly sessionId?: string | undefined
            readonly targetSessionId?: string | undefined
            readonly agent: string
            readonly firstInput?: string | undefined
          },
        ) =>
          Effect.gen(function* () {
            const allocated = start.sessionId ?? (yield* unusedId)

            return yield* tx(
              Effect.gen(function* () {
                const existing = fresh
                  ? undefined
                  : start.targetSessionId !== undefined
                    ? yield* findSession(start.targetSessionId)
                    : yield* latestRoot(project)

                const creating = existing === undefined || existing.endedAt !== null
                const targetId = creating ? allocated : existing.id

                yield* clearAt(location.runtime, location.address, targetId)
                const movingHere = moving.has(targetId)

                const at = yield* now

                const message =
                  creating && start.firstInput !== undefined
                    ? yield* queueInbox({
                        recipient: targetId,
                        sender: { type: "user" },
                        content: start.firstInput,
                        at,
                      })
                    : undefined

                if (creating) {
                  yield* publish(SessionCreated, {
                    sessionId: targetId,
                    at,
                    data: {
                      project,
                      agent: start.agent,
                      name: entryLabel(start.projectDirectory ?? ""),
                      directory: start.projectDirectory ?? "",
                      ...(message !== undefined && { message }),
                    },
                  })
                }

                if (start.projectDirectory) {
                  const [own] = yield* sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${targetId}`

                  if (own?.directory === "")
                    yield* publish(SessionDirectoryChanged, {
                      sessionId: targetId,
                      at,
                      data: { directory: start.projectDirectory },
                    })
                }

                const current = yield* currentProcess(targetId)

                if (current !== undefined && current.ended === null)
                  yield* endProcess(targetId, movingHere ? "move" : "exited", at)

                const harnessSessionId = current?.harnessSessionId ?? null

                const resume =
                  !creating &&
                  current?.start.harness === harness &&
                  harnessSessionId !== null &&
                  (yield* canResumeConversation(targetId, harnessSessionId))
                    ? harnessSessionId
                    : undefined

                const process = yield* startProcess(
                  targetId,
                  {
                    harness,
                    ...(start.provider && { provider: start.provider }),
                    ...(start.model && { model: start.model }),
                    ...(start.routing && { routing: start.routing }),
                    runtime: location.runtime,
                    terminal: location.address.id,
                    ...(resume !== undefined && { resume }),
                    ...(start.pid !== undefined && { pid: start.pid }),
                  },
                  at,
                )

                let execution: number | undefined

                if (start.firstInput !== undefined && resume === undefined) {
                  execution = yield* allocateExecution(targetId, at)

                  if (message === undefined) {
                    const queued = yield* queueInbox({
                      recipient: targetId,
                      sender: { type: "user" },
                      content: start.firstInput,
                      at,
                    })

                    yield* inbox.moveInbox(sql`recipient_session_id = ${targetId} AND id = ${queued}`, "delivering", {
                      execution,
                    })
                  }

                  yield* inbox.linkTask(targetId, execution, at)
                }

                yield* afterCommit(() => void moving.delete(targetId))

                return {
                  sessionId: targetId,
                  harnessSessionId: resume ?? null,
                  projectId: project,
                  process,
                  ...(execution !== undefined && { execution }),
                  firstInput: resume === undefined ? start.firstInput : undefined,
                }
              }),
            )
          }).pipe(Effect.orDie),
      ),

      noteConversation: Effect.fn("Db.session.noteConversation")((id: string, conversation: string, process?: number) =>
        tx(session.noteConversation(id, conversation, process)).pipe(Effect.orDie),
      ),

      rename: Effect.fn("Db.session.rename")((id: string, name: string) =>
        tx(session.rename(id, name)).pipe(Effect.orDie),
      ),

      setStatus: Effect.fn("Db.session.setStatus")((id: string, status: AgentStatus) =>
        tx(setStatus(id, status)).pipe(Effect.orDie),
      ),

      placeProcess: Effect.fn("Db.session.placeProcess")((id: string, terminal: string, pid?: number) =>
        tx(session.placeProcess(id, terminal, pid)).pipe(Effect.orDie),
      ),

      noteIntegration: Effect.fn("Db.session.noteIntegration")(
        (id: string, integration: Integration, process?: number) =>
          Effect.gen(function* () {
            const exists = yield* sql`SELECT 1 FROM session WHERE id = ${id}`

            if (exists.length === 0) return false
            const current = yield* currentProcess(id)

            if (process !== undefined && process !== current?.id) return false
            const known = (yield* sessionLive.integration(id)) ?? current?.integration

            if (known?.version === integration.version && known.protocol === integration.protocol) return false
            yield* sessionLive.setIntegration(id, integration)

            return true
          }).pipe(Effect.orDie),
      ),

      patchLive: Effect.fn("Db.session.patchLive")(
        (
          id: string,
          patch: {
            readonly pid?: number | null
            readonly ready?: number | null
            readonly integration?: Integration
            readonly reporter?: number | undefined
          },
        ) =>
          tx(
            Effect.gen(function* () {
              const { ready, pid } = patch

              if (!Predicate.isNumber(ready)) {
                if (!Predicate.isNumber(pid)) return undefined
                const current = yield* currentProcess(id)

                if (current === undefined) return undefined
                yield* publish(ProcessPid, { sessionId: id, data: { process: current.id, pid } })

                return current.id
              }

              const current = yield* currentProcess(id)

              if (current === undefined) return undefined

              if (!(yield* fromCurrentHarness(id, current.id, patch.reporter, pid ?? undefined))) return undefined
              const integration = patch.integration ?? (yield* sessionLive.integration(id))

              if (integration !== undefined) yield* afterCommitLive(sessionLive.setIntegration(id, integration))

              if ((yield* openExecution(id)) === undefined && (yield* sessionLive.status(id)) === "unknown")
                yield* setStatus(id, "idle")
              yield* publish(ProcessReady, {
                sessionId: id,
                at: ready,
                data: {
                  process: current.id,
                  ...(Predicate.isNumber(pid) && { pid }),
                  ...(integration !== undefined && { integration }),
                },
              })

              return current.id
            }),
          ).pipe(Effect.orDie),
      ),

      readyAt: Effect.fn("Db.session.readyAt")((id: string) =>
        currentProcess(id).pipe(
          Effect.map((current) => current?.readyAt ?? undefined),
          Effect.orDie,
        ),
      ),

      restartProcess: Effect.fn("Db.session.restartProcess")((id: string) =>
        tx(
          Effect.gen(function* () {
            const current = yield* currentProcess(id)

            if (current === undefined) return undefined
            yield* endProcess(id, "restart")
            const { resume: _, pid: __, ...start } = current.start

            return yield* startProcess(id, {
              ...start,
              ...(current.harnessSessionId && { resume: current.harnessSessionId }),
            })
          }),
        ).pipe(Effect.orDie),
      ),

      startProcess: Effect.fn("Db.session.startProcess")((id: string, start: ProcessStart) =>
        tx(ensureProcess(id, start)).pipe(Effect.orDie),
      ),

      endProcess: Effect.fn("Db.session.endProcess")((id: string, reason: ProcessEndReason, process?: number) =>
        tx(endProcess(id, reason, undefined, process)).pipe(Effect.orDie),
      ),

      stopProcess: Effect.fn("Db.session.stopProcess")((id: string, by: Sender) =>
        tx(endProcess(id, "stopped", undefined, undefined, by)).pipe(Effect.orDie),
      ),

      detachSession: Effect.fn("Db.session.detachSession")(
        (sessionId: string, runtime: string, address: RuntimeAddress) =>
          Effect.gen(function* () {
            const here = (yield* liveSessionsAt(runtime, address)).some((m) => m.id === sessionId)

            if (here) moving.add(sessionId)

            return here
          }).pipe(Effect.orDie),
      ),

      reattachSession: Effect.fn("Db.session.reattachSession")((sessionId: string) =>
        Effect.sync(() => {
          moving.delete(sessionId)
        }),
      ),

      lastSessionAt: Effect.fn("Db.session.lastSessionAt")((runtime: string, address: RuntimeAddress) =>
        session.lastSessionAt(runtime, address).pipe(Effect.orDie),
      ),

      lastProjectTerminal: Effect.fn("Db.session.lastProjectTerminal")((projectId: string, runtime: string) =>
        session.lastProjectTerminal(projectId, runtime).pipe(Effect.orDie),
      ),

      processesAt: Effect.fn("Db.session.processesAt")((runtime: string, address: RuntimeAddress) =>
        session.processesAt(runtime, address).pipe(Effect.orDie),
      ),

      sessionMoving: Effect.fn("Db.session.sessionMoving")((sessionId: string) =>
        Effect.sync(() => moving.has(sessionId)),
      ),

      canResumeConversation,

      openExecution: Effect.fn("Db.session.openExecution")((id: string) => openExecution(id).pipe(Effect.orDie)),
      workingExecutions: Effect.fn("Db.session.workingExecutions")(() => workingExecutions.pipe(Effect.orDie)),

      archive: Effect.fn("Db.session.archive")((id: string) =>
        tx(
          Effect.gen(function* () {
            const execution = yield* openExecution(id)

            if (execution !== undefined)
              yield* releaseExecution(
                id,
                execution,
                (yield* startedAt(id, execution)) === null ? "not_started" : "lost",
              )
            yield* session.archive(id)
          }),
        ).pipe(Effect.orDie),
      ),

      startExecution: Effect.fn("Db.session.startExecution")((id: string, at: number) =>
        tx(
          Effect.gen(function* () {
            const open = yield* openExecution(id)

            if (open !== undefined) return { execution: open, opened: false }

            return { execution: yield* allocateExecution(id, at), opened: true }
          }),
        ).pipe(Effect.orDie),
      ),

      acceptExecution: Effect.fn("Db.session.acceptExecution")((id: string, execution: number) =>
        tx(
          Effect.gen(function* () {
            const accepted = yield* accept(id, execution)

            if (accepted) yield* inbox.confirmTask(id, execution)

            return accepted
          }),
        ).pipe(Effect.orDie),
      ),

      executionAccepted: Effect.fn("Db.session.executionAccepted")((id: string) =>
        Effect.gen(function* () {
          const execution = yield* openExecution(id)

          return execution !== undefined && (yield* startedAt(id, execution)) !== null
        }).pipe(Effect.orDie),
      ),

      executionWasAccepted: Effect.fn("Db.session.executionWasAccepted")((id: string, execution: number) =>
        sql<{ ok: number }>`SELECT 1 AS ok FROM execution
          WHERE session_id = ${id} AND id = ${execution} AND (started_at IS NOT NULL OR outcome = 'completed')`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      ),

      admitProcess: Effect.fn("Db.session.admitProcess")((id: string, start: ProcessStart, max: number | undefined) =>
        tx(
          Effect.gen(function* () {
            if (!(yield* roomFor(max))) return false
            yield* ensureProcess(id, start)

            return true
          }),
        ).pipe(Effect.orDie),
      ),

      unstartedRuns: Effect.fn("Db.session.unstartedRuns")(() =>
        sql<{ id: string }>`SELECT s.id FROM session s
          WHERE s.ended_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM process p WHERE p.session_id = s.id)
            AND (s.parent_session_id IS NOT NULL OR s.origin_remote IS NOT NULL)`.pipe(
          Effect.map((rows) => rows.map((row) => row.id)),
          Effect.orDie,
        ),
      ),

      endUnstarted: Effect.fn("Db.session.endUnstarted")(
        (id: string, outcome: "not_started" | "interrupted", notice?: string) =>
          tx(
            Effect.gen(function* () {
              const at = yield* now
              const execution = (yield* openExecution(id)) ?? (yield* allocateExecution(id, at))
              yield* finishExecution(id, execution, { outcome })
              yield* inbox.dropUnsent(id, "the session did not start")

              if (notice !== undefined) yield* insertInboxRow({ sessionId: id, message: notice })
            }),
          ).pipe(Effect.orDie),
      ),

      currentProcessId: Effect.fn("Db.session.currentProcessId")((id: string) =>
        currentProcessId(id).pipe(Effect.orDie),
      ),

      closeExecution: Effect.fn("Db.session.closeExecution")(
        (
          id: string,
          execution: number,
          status: Exclude<ExecutionState, "none" | "open">,
          options: { readonly failure?: ExecutionFailure | undefined; readonly notice?: string } = {},
        ) =>
          tx(
            Effect.gen(function* () {
              if ((yield* openExecution(id)) !== execution) return false

              const closed = yield* finishExecution(id, execution, {
                outcome: status,
                ...(options.failure !== undefined && { failure: options.failure }),
              })

              if (!closed) return false

              if (status === "completed") yield* inbox.confirm(id, execution)

              if (options.notice !== undefined && !(yield* isRoot(id)))
                yield* insertInboxRow({ sessionId: id, message: options.notice })

              return true
            }),
          ).pipe(Effect.orDie),
      ),

      executionTaken: Effect.fn("Db.session.executionTaken")((id: string) =>
        Effect.gen(function* () {
          const execution = yield* openExecution(id)

          if (execution === undefined) return false

          const [row] = yield* sql<{ taken: number }>`SELECT (t.started_at IS NOT NULL OR t.typed IS NOT NULL) AS taken
            FROM execution t WHERE t.session_id = ${id} AND t.id = ${execution}`

          return row?.taken === 1
        }).pipe(Effect.orDie),
      ),

      startObserved: Effect.fn("Db.session.startObserved")(
        (id: string, typed: string | undefined, at: number, process?: number, _anonymous = false) =>
          tx(
            Effect.gen(function* () {
              if (!(yield* observable(id)) || (yield* fromOldProcess(id, process))) return

              if (typed === undefined || typed === "") return
              const open = yield* openExecution(id)

              if (open === undefined) yield* allocateExecution(id, at, typed)
              else yield* noteInput(id, open, typed)

              yield* setStatus(id, "working")
            }),
          ).pipe(Effect.orDie),
      ),

      endObserved: Effect.fn("Db.session.endObserved")((id: string, end: ObservedEnd, process?: number) =>
        tx(
          Effect.gen(function* () {
            if (!(yield* observable(id))) return undefined
            const current = yield* currentProcess(id)

            if (current === undefined || current.start.harness !== end.harness) return undefined

            if (end.needsReady && current.readyAt === null && process !== current.id) return undefined

            if (end.execution === undefined && process !== undefined && process !== current.id) return undefined
            const failure = end.limited ? limitFailure(end.failure ?? "", end.resetAt) : failureOf(end.failure)

            const recorded = yield* recordObservedEnd(
              id,
              {
                outcome: end.status,
                ...(failure !== undefined && { failure }),
                ...(end.conversation !== undefined && { conversation: end.conversation }),
                reply: end.reply,
              },
              end.at,
              current.id,
              end.execution,
              end.needsReady,
              end.pulls ?? false,
            )

            const updateConversation =
              end.conversation !== undefined && end.conversation !== current.harnessSessionId
                ? session.noteConversation(id, end.conversation, process)
                : Effect.void

            if (recorded === undefined || recorded.kind === "unaccepted") {
              yield* updateConversation

              return undefined
            }

            if (recorded.kind === "duplicate") {
              if (!recorded.active) yield* updateConversation

              return end.status
            }

            yield* updateConversation

            if (recorded.kind === "unmatched") {
              yield* setStatus(id, "idle")

              return undefined
            }

            if (recorded.wrote)
              yield* end.status === "completed" && !(yield* sessionLive.isPrompting(id))
                ? inbox.confirm(id, recorded.id)
                : inbox.confirmTask(id, recorded.id)

            if (!recorded.wrote || !recorded.current) return end.status

            yield* setStatus(id, "idle")

            if (end.status === "failed" && !(yield* isRoot(id)))
              yield* insertInboxRow(
                {
                  sessionId: id,
                  message:
                    failure?.kind === "limit"
                      ? `${yield* session.labelOf(id)} (${end.harness}) hit a usage limit: ${limitText(failure, end)}`
                      : `${yield* session.labelOf(id)} ended its execution with an error: ${end.failure}`,
                },
                end.at,
              )

            return end.status
          }),
        ).pipe(Effect.orDie),
      ),

      endExecution: Effect.fn("Db.session.endExecution")(
        (id: string, end: ExecutionEnd, notice: string | undefined, at?: number) =>
          tx(
            Effect.gen(function* () {
              const stamp = at === undefined ? yield* now : Math.max(at, yield* now)
              const execution = (yield* openExecution(id)) ?? (yield* allocateExecution(id, stamp))
              const wrote = yield* finishExecution(id, execution, end, stamp)

              if (wrote && end.outcome === "completed") yield* inbox.confirm(id, execution)

              if (notice !== undefined) yield* insertInboxRow({ sessionId: id, message: notice }, stamp)
            }),
          ).pipe(Effect.orDie),
      ),

      latestReply: Effect.fn("Db.session.latestReply")(session.latestReply),

      projectOfSession: Effect.fn("Db.session.projectOfSession")((sessionId: string) =>
        sql<{ project: string }>`SELECT project_id AS project FROM session WHERE id = ${sessionId}`.pipe(
          Effect.map((rows) => rows[0]?.project),
          Effect.orDie,
        ),
      ),
    }
  })

export type Interface = Effect.Success<ReturnType<typeof make>>
