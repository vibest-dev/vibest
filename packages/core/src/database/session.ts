import {
  ExecutionEnded,
  ProcessEnded,
  type ProcessEndReason,
  ProcessPid,
  ProcessReady,
  ProjectEntryChanged,
  SessionCreated,
  SessionDirectoryChanged,
  SessionEnded,
} from "@vibest/schema/event"
import {
  type AgentStatus,
  AmbiguousSession,
  type ExecutionState,
  NoSuchSession,
  RuntimeAddress,
  type HarnessId,
} from "@vibest/schema/session"
import { Clock, Effect } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"
import { type ObservedEnd } from "../replies.ts"
import { SessionLive } from "../session/live.ts"
import {
  attemptsOf,
  failureOf,
  type ExecutionEnd,
  type Integration,
  type NewSession,
  type ProcessStart,
  type SpawnedBefore,
} from "./db-rows.ts"
import type * as Inbox from "./inbox.ts"
import type * as Remote from "./remote.ts"
import type * as Session from "./session-statements.ts"

export type SessionFilter = {
  readonly projectId?: string
  readonly stopped?: boolean
  readonly peer?: Remote.PeerScope | undefined
}

export const make = (session: Session.Statements, inbox: Inbox.Statements, remote: Remote.Statements) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { publish, afterCommit, transaction: tx } = yield* Bus
    const sessionLive = yield* SessionLive
    const now = Clock.currentTimeMillis
    const {
      reads,
      afterCommitLive,
      moving,
      running,
      selectRaw,
      selectSessions,
      findSession,
      currentProcess,
      currentProcessId,
      findEntrySessions,
      openExecution,
      startExecution,
      acceptedAt,
      accept,
      observable,
      isEntry,
      fromOldProcess,
      endProcess,
      startProcess,
      ensureProcess,
      endExecution,
      setStatus,
      entrySessionsAt,
      unusedId,
      conversationOf,
      creatorOf,
    } = session
    const { queueInbox, insertInboxRow, dropWaiting } = inbox

    const clearEntryAt = (runtime: string, address: RuntimeAddress, except?: string) =>
      Effect.gen(function* () {
        for (const entry of yield* entrySessionsAt(runtime, address, except)) {
          yield* endProcess(entry.id, "exited")
          yield* dropWaiting(entry.project)
        }
      })

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
          WHERE t.session_id = ${sessionId} AND t.outcome IS NOT NULL
            AND p.conversation = ${harnessSessionId}
        )
        OR (
          EXISTS (SELECT 1 FROM project WHERE entry_session_id = ${sessionId})
          AND EXISTS (SELECT 1 FROM process WHERE session_id = ${sessionId} AND conversation = ${harnessSessionId})
        )
      ) AS ok`.pipe(
        Effect.map((rows) => rows[0]?.ok === 1),
        Effect.orDie,
      )

    return {
      sessionParents: (ids: ReadonlyArray<string>) =>
        (ids.length === 0
          ? Effect.succeed([] as ReadonlyArray<{ id: string; parentSessionId: string | null }>)
          : sql<{ id: string; parentSessionId: string | null }>`SELECT id, parent_session_id FROM session
              WHERE ${sql.in("id", ids)}`
        ).pipe(
          Effect.map((rows) => new Map(rows.map((row) => [row.id, row.parentSessionId]))),
          Effect.orDie,
        ),

      sessionDirectory: (id: string) =>
        sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows[0]?.directory),
          Effect.orDie,
        ),

      startedByPeer: (id: string) =>
        sql`SELECT 1 FROM session WHERE id = ${id} AND origin_peer IS NOT NULL`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),

      hadTerminal: (id: string) => reads.hadTerminal(id).pipe(Effect.orDie),

      liveSharers: (id: string) =>
        sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
          WHERE o.id != s.id AND o.directory = s.directory AND s.directory != '' AND o.ended_at IS NULL
          ORDER BY o.id`.pipe(
          Effect.map((rows) => rows.map((r) => r.id)),
          Effect.orDie,
        ),

      earlierSharer: (id: string) =>
        sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
          WHERE o.id != s.id AND o.directory = s.directory AND s.directory != ''
            AND (o.created_at, o.rowid) < (s.created_at, s.rowid)
          ORDER BY o.created_at, o.rowid LIMIT 1`.pipe(
          Effect.map((rows) => rows[0]?.id),
          Effect.orDie,
        ),

      creatorOf,

      nearestAlive: session.nearestAlive,

      creatorLabel: (id: string) =>
        Effect.gen(function* () {
          const creator = yield* creatorOf(id)
          if (creator === undefined) return undefined
          if ("peer" in creator) return { id: creator.session, label: "the agent that started you" }
          const [row] = yield* sql<{ entry: string | null; name: string | null }>`SELECT
              p.entry_session_id AS entry, c.name AS name
            FROM session s JOIN project p ON p.id = s.project_id LEFT JOIN session c ON c.id = ${creator.local}
            WHERE s.id = ${id}`
          const label =
            creator.local === row?.entry
              ? "the entry session"
              : row?.name
                ? `agent ${row.name}`
                : "the agent that started you"
          return { id: creator.local, label }
        }).pipe(Effect.orDie),

      insertSession: (
        row: Omit<NewSession, "projectId">,
        project: string,
        {
          max,
          cwd = "",
          task,
          parentSessionId,
          request,
          origin,
          archiveOnIdle: archives = false,
        }: {
          readonly max?: number | undefined
          readonly cwd?: string
          readonly task?: string
          readonly parentSessionId?: string | undefined
          readonly request?: string | undefined
          readonly origin?: Remote.PeerStart | undefined
          readonly archiveOnIdle?: boolean
        } = {},
      ): Effect.Effect<boolean | SpawnedBefore | "parent-ended"> =>
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
            if (max !== undefined) {
              const n = (yield* selectRaw(
                [sql`s.ended_at IS NULL`, sql`NOT EXISTS (SELECT 1 FROM project q WHERE q.entry_session_id = s.id)`],
                running,
              )).length
              if (n >= max) return false
            }
            yield* publish(SessionCreated, {
              sessionId: row.id,
              at: row.createdAt,
              data: {
                project,
                agent: row.agent,
                name: row.name,
                directory: cwd,
                ...(parentSessionId === undefined ? {} : { parent: parentSessionId }),
                ...(origin === undefined
                  ? {}
                  : {
                      origin: {
                        peer: origin.peer,
                        project: origin.project,
                        ...(origin.reportTo === undefined ? {} : { session: origin.reportTo }),
                      },
                    }),
              },
            })
            if (archives) yield* afterCommitLive(sessionLive.archiveWhenIdle(row.id))
            const processAt = row.startedAt ?? row.createdAt
            const process = yield* startProcess(
              row.id,
              {
                harness: row.harnessId,
                ...(row.provider ? { provider: row.provider } : {}),
                ...(row.model ? { model: row.model } : {}),
                ...(row.routing === undefined ? {} : { routing: row.routing }),
                runtime: row.runtime,
                terminal: row.address.id,
                ...(row.harnessSessionId ? { resume: row.harnessSessionId } : {}),
              },
              processAt,
            )
            if (row.exitedAt !== null)
              yield* publish(ProcessEnded, { sessionId: row.id, at: row.exitedAt, data: { process, reason: "exited" } })
            if (task !== undefined)
              yield* queueInbox({
                recipient: row.id,
                kind: "task",
                sender: parentSessionId ?? null,
                content: task,
                status: "delivered",
                request,
              })
            if (row.executionState !== "none") {
              const execution = yield* startExecution(row.id, row.executionPromptedAt)
              yield* inbox.linkTask(row.id, execution, row.executionPromptedAt)
              if (row.executionState !== "open")
                yield* publish(ExecutionEnded, {
                  sessionId: row.id,
                  at: row.executionPromptedAt,
                  data: { execution, outcome: row.executionState },
                })
            }
            yield* afterCommitLive(sessionLive.setStatus(row.id, row.status))
            return true
          }),
        ).pipe(Effect.orDie),

      resolveSession: (input: string, scope?: Remote.PeerScope) =>
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
            ${scope === undefined ? sql`` : sql`AND ${remote.ofPeer(sql`s.id`, scope)}`} ORDER BY s.id LIMIT 11`.pipe(
            Effect.orDie,
          )
          if (rows.length === 0) return yield* new NoSuchSession({ id: input, message: `no session ${input}` })
          if (rows.length > 1) return yield* new AmbiguousSession({ prefix: input, matches: rows.map((r) => r.id) })
          return rows[0]!.id
        }),

      newSessionId: unusedId.pipe(Effect.orDie),

      sessionIdentity: (id: string) =>
        sql<{
          id: string
          projectId: string
          agent: string
          harness: string
          entry: number
        }>`SELECT a.id, a.project_id, a.agent,
            coalesce(p.harness, '') AS harness,
            q.entry_session_id = a.id AS entry
          FROM session a JOIN project q ON q.id = a.project_id
          LEFT JOIN process p ON p.session_id = a.id AND p.id = a.process_id
          WHERE a.id = ${id}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? undefined : { ...rows[0], entry: rows[0].entry === 1 })),
          Effect.orDie,
        ),

      getSession: (id: string) => findSession(id).pipe(Effect.orDie),

      listSessions: (filter: SessionFilter = {}) =>
        selectSessions(
          [
            ...(filter.projectId === undefined ? [] : [sql`s.project_id = ${filter.projectId}`]),
            ...(filter.peer === undefined ? [] : [remote.ofPeer(sql`s.id`, filter.peer)]),
          ],
          filter.stopped ? undefined : running,
        ).pipe(Effect.orDie),

      sessionBriefs: (ids: ReadonlyArray<string>) => reads.briefs(ids).pipe(Effect.orDie),

      entrySessions: findEntrySessions().pipe(Effect.orDie),

      allocateSessionId: () => unusedId,

      entryOf: (projectIdValue: string) =>
        findEntrySessions(projectIdValue).pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        ),

      entryAt: (runtime: string, address: RuntimeAddress) =>
        entrySessionsAt(runtime, address).pipe(
          Effect.map((rows) => rows[0]?.project),
          Effect.orDie,
        ),

      sessionAt: (runtime: string, address: RuntimeAddress) => session.sessionAt(runtime, address).pipe(Effect.orDie),

      startEntry: (
        project: string,
        harness: HarnessId,
        fresh: boolean,
        location: { readonly runtime: string; readonly address: RuntimeAddress },
        start: {
          readonly provider?: string | undefined
          readonly model?: string | undefined
          readonly routing?: unknown
          readonly projectDirectory?: string | undefined
          readonly pid?: number | undefined
          readonly sessionId?: string | undefined
          readonly agent: string
          readonly firstInput?: string | undefined
        },
      ) =>
        Effect.gen(function* () {
          const id = start.sessionId ?? (yield* unusedId)
          return yield* tx(
            Effect.gen(function* () {
              yield* clearEntryAt(location.runtime, location.address, project)
              const movingHere = moving.has(project)
              const [existing] = yield* sql<{
                entry: string | null
              }>`SELECT entry_session_id AS entry FROM project WHERE id = ${project}`
              const at = yield* now
              if (!existing?.entry || fresh) {
                if (existing?.entry) {
                  yield* endProcess(existing.entry, "archived", at)
                  yield* publish(SessionEnded, { sessionId: existing.entry, at, data: { reason: "replaced" } })
                }
                yield* publish(SessionCreated, {
                  sessionId: id,
                  at,
                  data: { project, agent: start.agent, name: "entry", directory: start.projectDirectory ?? "" },
                })
                yield* publish(ProjectEntryChanged, { projectId: project, at, data: { session: id } })
              }
              const entryId = !existing?.entry || fresh ? id : existing.entry
              if (start.projectDirectory) {
                const [own] = yield* sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${entryId}`
                if (own?.directory === "")
                  yield* publish(SessionDirectoryChanged, {
                    sessionId: entryId,
                    at,
                    data: { directory: start.projectDirectory },
                  })
              }
              const { current, conversation } = yield* conversationOf(entryId)
              if (current !== undefined && current.ended === null)
                yield* endProcess(entryId, movingHere ? "move" : "exited", at)
              const resume =
                !fresh &&
                current?.start.harness === harness &&
                conversation !== null &&
                (yield* canResumeConversation(entryId, conversation))
                  ? conversation
                  : undefined
              yield* startProcess(
                entryId,
                {
                  harness,
                  ...(start.provider ? { provider: start.provider } : {}),
                  ...(start.model ? { model: start.model } : {}),
                  ...(start.routing ? { routing: start.routing } : {}),
                  runtime: location.runtime,
                  terminal: location.address.id,
                  ...(resume === undefined ? {} : { resume }),
                  ...(start.pid === undefined ? {} : { pid: start.pid }),
                },
                at,
              )
              if (start.firstInput !== undefined && resume === undefined)
                yield* queueInbox({
                  recipient: entryId,
                  kind: "task",
                  sender: null,
                  content: start.firstInput,
                  status: "delivered",
                })
              yield* afterCommit(() => void moving.delete(project))
              if (!movingHere || fresh) yield* dropWaiting(project)
              return { sessionId: entryId, harnessSessionId: resume ?? null, projectId: project }
            }),
          )
        }).pipe(Effect.orDie),

      noteConversation: (id: string, conversation: string, process?: number) =>
        tx(session.noteConversation(id, conversation, process)).pipe(Effect.orDie),

      rename: (id: string, name: string) => tx(session.rename(id, name)).pipe(Effect.orDie),

      setStatus: (id: string, status: AgentStatus) => tx(setStatus(id, status)).pipe(Effect.orDie),

      placeProcess: (id: string, terminal: string, pid?: number) =>
        tx(session.placeProcess(id, terminal, pid)).pipe(Effect.orDie),

      attempts: (id: string) =>
        sql<{ attempts: string | null }>`SELECT json_group_array(json_object('harness', harness, 'provider', provider,
            'at', ended_at)) AS attempts
          FROM (SELECT * FROM process WHERE session_id = ${id} AND end_reason = 'limited' ORDER BY id)`.pipe(
          Effect.map((rows) => attemptsOf(rows[0]?.attempts ?? null)),
          Effect.orDie,
        ),

      noteIntegration: (id: string, integration: Integration, process?: number) =>
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

      patchLive: (
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
            const ready = typeof patch.ready === "number"
            if (!ready && typeof patch.pid !== "number") return undefined
            const current = yield* currentProcess(id)
            if (current === undefined) return undefined
            if (ready && !(yield* fromCurrentHarness(id, current.id, patch.reporter, patch.pid ?? undefined)))
              return undefined
            const integration = patch.integration ?? (yield* sessionLive.integration(id))
            if (!ready) {
              yield* publish(ProcessPid, { sessionId: id, data: { process: current.id, pid: patch.pid as number } })
              return current.id
            }
            if (integration !== undefined) yield* afterCommitLive(sessionLive.setIntegration(id, integration))
            yield* publish(ProcessReady, {
              sessionId: id,
              at: patch.ready as number,
              data: {
                process: current.id,
                ...(typeof patch.pid === "number" ? { pid: patch.pid } : {}),
                ...(integration === undefined ? {} : { integration }),
              },
            })
            return current.id
          }),
        ).pipe(Effect.orDie),

      readyAt: (id: string) =>
        currentProcess(id).pipe(
          Effect.map((current) => current?.readyAt ?? undefined),
          Effect.orDie,
        ),

      restartProcess: (id: string) =>
        tx(
          Effect.gen(function* () {
            const { current, conversation } = yield* conversationOf(id)
            if (current === undefined) return
            yield* endProcess(id, "restart")
            const { resume: _, pid: __, ...start } = current.start
            yield* startProcess(id, { ...start, ...(conversation ? { resume: conversation } : {}) })
          }),
        ).pipe(Effect.orDie),

      startProcess: (id: string, start: ProcessStart) => tx(ensureProcess(id, start)).pipe(Effect.orDie),

      endProcess: (id: string, reason: ProcessEndReason) => tx(endProcess(id, reason)).pipe(Effect.orDie),

      detachEntry: (projectIdValue: string, runtime: string, address: RuntimeAddress) =>
        Effect.gen(function* () {
          const here = (yield* entrySessionsAt(runtime, address)).some((m) => m.project === projectIdValue)
          if (here) moving.add(projectIdValue)
          return here
        }).pipe(Effect.orDie),

      reattachEntry: (projectIdValue: string, _runtime: string, _address: RuntimeAddress) =>
        Effect.sync(() => {
          moving.delete(projectIdValue)
        }),

      clearEntry: (runtime: string, address: RuntimeAddress) =>
        tx(clearEntryAt(runtime, address)).pipe(Effect.asVoid, Effect.orDie),

      canResumeConversation,

      archiveIfNoPending: (id: string) =>
        tx(
          Effect.gen(function* () {
            const s = yield* findSession(id)
            if (s === undefined) return false
            if (yield* inbox.waitingOn(id)) return false
            const children =
              yield* sql`SELECT 1 FROM session WHERE parent_session_id = ${id} AND ended_at IS NULL LIMIT 1`
            if (children.length > 0) return false
            if ((yield* openExecution(id)) !== undefined) return false
            yield* session.archive(id)
            return true
          }),
        ).pipe(Effect.orDie),

      openExecution: (id: string) => openExecution(id).pipe(Effect.orDie),

      archive: (id: string) =>
        tx(
          Effect.gen(function* () {
            if ((yield* openExecution(id)) !== undefined) yield* endExecution(id, { outcome: "interrupted" })
            yield* session.archive(id)
          }),
        ).pipe(Effect.orDie),

      startExecution: (id: string, at: number) =>
        tx(
          Effect.gen(function* () {
            const open = yield* openExecution(id)
            if (open !== undefined) return { execution: open, opened: false }
            return { execution: yield* startExecution(id, at), opened: true }
          }),
        ).pipe(Effect.orDie),

      acceptExecution: (id: string, execution: number) => tx(accept(id, execution)).pipe(Effect.orDie),

      executionAccepted: (id: string) =>
        Effect.gen(function* () {
          const execution = yield* openExecution(id)
          return execution !== undefined && (yield* acceptedAt(id, execution)) !== null
        }).pipe(Effect.orDie),

      currentProcessId: (id: string) => currentProcessId(id).pipe(Effect.orDie),

      closeExecution: (
        id: string,
        execution: number,
        status: Exclude<ExecutionState, "none" | "open">,
        options: { readonly failure?: string; readonly notice?: string } = {},
      ) =>
        tx(
          Effect.gen(function* () {
            if ((yield* openExecution(id)) !== execution) return false
            const failure = failureOf(options.failure)
            yield* endExecution(id, { outcome: status, ...(failure === undefined ? {} : { failure }) })
            if (options.notice !== undefined && !(yield* isEntry(id)))
              yield* insertInboxRow({ sessionId: id, message: options.notice })
            return true
          }),
        ).pipe(Effect.orDie),

      executionTaken: (id: string) =>
        Effect.gen(function* () {
          const execution = yield* openExecution(id)
          if (execution === undefined) return false
          const [row] = yield* sql<{ taken: number }>`SELECT (t.accepted_at IS NOT NULL OR t.typed IS NOT NULL) AS taken
            FROM execution t WHERE t.session_id = ${id} AND t.id = ${execution}`
          return row?.taken === 1
        }).pipe(Effect.orDie),

      limitedSince: (sessionId: string, at: number) =>
        sql<{ harness: string; provider: string | null }>`SELECT harness, provider FROM process
          WHERE session_id = ${sessionId} AND end_reason = 'limited' AND ended_at >= ${at}
          ORDER BY id`.pipe(Effect.orDie),

      rescheduleSource: (id: string) => reads.rescheduleSource(id).pipe(Effect.orDie),

      limitSource: (id: string, limited: number) =>
        tx(
          Effect.gen(function* () {
            if ((yield* openExecution(id)) !== undefined) return undefined
            const [newest] = yield* sql<{
              id: number | null
            }>`SELECT max(id) AS id FROM execution WHERE session_id = ${id}`
            if ((newest?.id ?? 0) > limited) return undefined
            return yield* reads.rescheduleSource(id)
          }),
        ).pipe(Effect.orDie),

      startObserved: (id: string, typed: string | undefined, at: number, process?: number) =>
        tx(
          Effect.gen(function* () {
            if (!(yield* observable(id)) || (yield* fromOldProcess(id, process))) return
            const open = (yield* openExecution(id)) ?? (typed ? yield* startExecution(id, at, typed) : undefined)
            if (open === undefined) return
            yield* accept(id, open)
            yield* setStatus(id, "working")
          }),
        ).pipe(Effect.orDie),

      endObserved: (id: string, end: ObservedEnd, process?: number) =>
        tx(
          Effect.gen(function* () {
            if (!(yield* observable(id)) || (yield* fromOldProcess(id, process))) return undefined
            const current = yield* currentProcess(id)
            if (current === undefined || current.start.harness !== end.harness) return undefined
            if (end.needsReady && current.readyAt === null) return undefined
            const open = yield* openExecution(id)
            if (open === undefined && end.status === "interrupted") return undefined
            if (open !== undefined && (yield* acceptedAt(id, open)) === null) return "unaccepted" as const
            const failure = end.limited
              ? { message: end.failure ?? "", kind: "limit" as const }
              : failureOf(end.failure)
            yield* endExecution(
              id,
              {
                outcome: end.status,
                ...(failure === undefined ? {} : { failure }),
                ...(end.conversation === undefined || end.conversation === current.conversation
                  ? {}
                  : { conversation: end.conversation }),
                reply: end.reply,
              },
              end.at,
            )
            yield* setStatus(id, "idle")
            if (end.status === "failed" && !end.limited && !(yield* isEntry(id)))
              yield* insertInboxRow(
                { sessionId: id, message: `${id}'s execution ended with an error: ${end.failure}` },
                end.at,
              )
            return end.status
          }),
        ).pipe(Effect.orDie),

      endExecution: (id: string, end: ExecutionEnd, notice: string | undefined, at?: number) =>
        tx(
          Effect.gen(function* () {
            const stamp = at === undefined ? undefined : Math.max(at, yield* now)
            yield* endExecution(id, end, stamp)
            if (notice !== undefined) yield* insertInboxRow({ sessionId: id, message: notice }, stamp)
          }),
        ).pipe(Effect.orDie),

      latestReply: (sessionId: string) =>
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
        ),

      endedAtLimit: sql<{
        id: string
        runtime: string
      }>`SELECT s.id, p.runtime FROM session s
        JOIN process p ON p.session_id = s.id AND p.id = s.process_id
        JOIN execution t ON t.session_id = s.id AND t.id = (SELECT max(id) FROM execution WHERE session_id = s.id)
        WHERE s.ended_at IS NULL AND p.ended_at IS NOT NULL AND t.failure_kind = 'limit'`.pipe(Effect.orDie),

      limitedExecution: (sessionId: string) =>
        sql<{
          execution: number
          process: number | null
          failure: string
        }>`SELECT id AS execution, process_id AS process, failure FROM execution
          WHERE session_id = ${sessionId} AND failure_kind = 'limit'
            AND id = (SELECT max(id) FROM execution WHERE session_id = ${sessionId})`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        ),

      projectOfSession: (sessionId: string) =>
        sql<{ project: string }>`SELECT project_id AS project FROM session WHERE id = ${sessionId}`.pipe(
          Effect.map((rows) => rows[0]?.project),
          Effect.orDie,
        ),
    }
  })

export type Interface = Effect.Success<ReturnType<typeof make>>
