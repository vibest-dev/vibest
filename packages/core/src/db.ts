import {
  ProcessEnded,
  type ProcessEndReason,
  ProcessPid,
  ProcessReady,
  ProjectCreated,
  ProjectEntryChanged,
  ProjectMoved,
  ProjectRepositoriesChanged,
  SessionCreated,
  SessionDirectoryChanged,
  SessionEnded,
  ExecutionEnded,
} from "@vibest/schema/event"
import { newId } from "@vibest/schema/id"
import { type AgentStatus, AmbiguousSession, NoSuchSession, RuntimeAddress } from "@vibest/schema/session"
import { Context, Effect, Layer, String as Str } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "./bus.ts"
import { apply } from "./database/migration.ts"
import { inboxMethods } from "./db-inbox.ts"
import { remoteQueries, type PeerStart } from "./db-remote.ts"
import {
  attemptsOf,
  type NewSession,
  type SessionPatch,
  type SpawnedBefore,
  type RepositoryRow,
  type Integration,
} from "./db-rows.ts"
import { makeStore } from "./db-store.ts"
import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"
import type { HarnessId } from "./harness.ts"
import type { PeerScope } from "./remote.ts"
import { SessionLive } from "./session/live.ts"

export type { MachineRow, OutboxRow, PeerStart } from "./db-remote.ts"
export { InboxKind, type ProcessEndReason } from "@vibest/schema/event"
export { RuntimeAddress, InboxRow, InboxStatus, AgentStatus, ExecutionState } from "@vibest/schema/session"
export {
  AddressJson,
  encodeAddress,
  SessionRow,
  NewSession,
  type SessionPatch,
  EntryRow,
  type NewInboxRow,
  type SpawnedBefore,
  type RepositoryRow,
  type ExecutionEnd,
  failureOf,
  sessionEnded,
  type SessionBrief,
} from "./db-rows.ts"
export { APPLICATION_ID, DatabaseOpenFailed, SchemaMismatch, inspectSchema } from "./db-schema.ts"

export type SessionFilter = {
  readonly projectId?: string
  readonly stopped?: boolean
  readonly peer?: PeerScope | undefined
}

const make = Effect.gen(function* () {
  const store = yield* makeStore
  const {
    sql,
    reads,
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
    findEntrySessions,
    queueInbox,
    linkTask,
    endProcess,
    startProcess,
    startExecution,
    updateSession,
    dropWaiting,
    sessionAt,
    entrySessionsAt,
    clearEntryAt,
    unusedId,
    conversationOf,
    addressedCreator,
  } = store
  const remote = remoteQueries(store)
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
    ...remote.queries,
    projectAt: (root: string) =>
      sql<{ id: string; directory: string }>`SELECT id, directory FROM project WHERE directory = ${root}
        UNION ALL SELECT p.id, p.directory FROM project_repository r JOIN project p ON p.id = r.project_id
          WHERE r.path = ${root} LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    createProject: (directory: string, repositories: ReadonlyArray<RepositoryRow>) =>
      tx(
        Effect.gen(function* () {
          const [existing] = yield* sql<{ id: string }>`SELECT id FROM project WHERE directory = ${directory}`
          if (existing !== undefined) {
            const changed = yield* changedRepositories(existing.id, repositories)
            if (changed.length > 0)
              yield* emit(ProjectRepositoriesChanged, { projectId: existing.id, data: { repositories: changed } })
          } else {
            const id = yield* newId(projectPrefixTaken)
            yield* emit(ProjectCreated, {
              projectId: id,
              data: { ...(directory ? { directory } : {}), repositories: repositoriesOf(repositories) },
            })
          }
          const [row] = yield* sql<{ id: string }>`SELECT id FROM project WHERE directory = ${directory}`
          yield* notify({ type: "live.project", projectId: row!.id })
          return row!.id
        }),
      ).pipe(Effect.orDie),

    refreshRepositories: (id: string, repositories: ReadonlyArray<RepositoryRow>) =>
      tx(
        Effect.gen(function* () {
          const changed = yield* changedRepositories(id, repositories)
          if (changed.length > 0)
            yield* emit(ProjectRepositoriesChanged, { projectId: id, data: { repositories: changed } })
        }),
      ).pipe(Effect.orDie),

    moveCandidates: (remotes: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const wanted = [...new Set(remotes)].sort()
        if (wanted.length === 0) return []
        const rows = yield* sql<{ id: string; directory: string; remote: string | null }>`SELECT p.id, p.directory,
            r.remote_url AS remote FROM project p JOIN project_repository r ON r.project_id = p.id
          WHERE p.directory IS NOT NULL AND p.id IN (SELECT project_id FROM project_repository WHERE ${sql.in("remote_url", wanted)})`
        const byProject = new Map<string, { directory: string; remotes: Set<string> }>()
        for (const row of rows) {
          const entry = byProject.get(row.id) ?? { directory: row.directory, remotes: new Set<string>() }
          if (row.remote !== null) entry.remotes.add(row.remote)
          byProject.set(row.id, entry)
        }
        return [...byProject]
          .filter(([, p]) => [...p.remotes].sort().join("\n") === wanted.join("\n"))
          .map(([id, p]) => ({ id, directory: p.directory }))
      }).pipe(Effect.orDie),

    moveProject: (id: string, to: string, repositories: ReadonlyArray<RepositoryRow>) =>
      tx(
        Effect.gen(function* () {
          const [row] = yield* sql<{ directory: string }>`SELECT directory FROM project WHERE id = ${id}`
          const from = row!.directory
          yield* emit(ProjectMoved, {
            projectId: id,
            data: { from, to, repositories: repositoriesOf(repositories) },
          })
          yield* notify({ type: "live.project", projectId: id })
          for (const session of yield* sql<{
            id: string
          }>`SELECT id FROM session WHERE project_id = ${id} AND ended_at IS NULL`)
            yield* notify({ type: "live.session", sessionId: session.id })
          return from
        }),
      ).pipe(Effect.orDie),

    watchProjects: (id?: string) =>
      sql<{ id: string; directory: string | null; entrySessionId: string | null }>`SELECT id, directory,
          entry_session_id FROM project WHERE directory IS NOT NULL ${id === undefined ? sql`` : sql`AND id = ${id}`}
          ORDER BY rowid`.pipe(Effect.orDie),

    sessionParents: (ids: ReadonlyArray<string>) =>
      (ids.length === 0
        ? Effect.succeed([] as ReadonlyArray<{ id: string; parentSessionId: string | null }>)
        : sql<{ id: string; parentSessionId: string | null }>`SELECT id, parent_session_id FROM session
            WHERE ${sql.in("id", ids)}`
      ).pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.id, row.parentSessionId]))),
        Effect.orDie,
      ),

    projectDirectory: (id: string) =>
      sql<{ directory: string | null }>`SELECT directory FROM project WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.directory ?? undefined),
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
          AND o.ended_at IS NULL AND (o.created_at, o.rowid) < (s.created_at, s.rowid)
        ORDER BY o.created_at, o.rowid LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.id),
        Effect.orDie,
      ),

    addressedCreator,

    maySend: (sender: string, recipient: string) =>
      Effect.gen(function* () {
        const from = yield* addressedCreator(sender)
        const to = yield* addressedCreator(recipient)
        return from === recipient || to === sender
      }),

    creatorOf: (id: string) =>
      sql<{ parent: string | null; peer: string | null; session: string | null }>`SELECT
          parent_session_id AS parent, origin_peer AS peer, origin_session AS session
        FROM session WHERE id = ${id}`.pipe(
        Effect.map(([row]) => {
          if (row === undefined) return undefined
          if (row.peer !== null && row.session !== null) return { peer: row.peer, session: row.session }
          if (row.parent !== null) return { local: row.parent }
          return undefined
        }),
        Effect.orDie,
      ),

    creatorLabel: (id: string) =>
      Effect.gen(function* () {
        const creator = yield* addressedCreator(id)
        if (creator === undefined) return undefined
        const [row] = yield* sql<{ entry: string | null; name: string | null }>`SELECT
            p.entry_session_id AS entry, c.name AS name
          FROM session s JOIN project p ON p.id = s.project_id LEFT JOIN session c ON c.id = ${creator}
          WHERE s.id = ${id}`
        const label =
          creator === row?.entry ? "the entry session" : row?.name ? `agent ${row.name}` : "the agent that started you"
        return { id: creator, label }
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
        readonly origin?: PeerStart | undefined
        readonly archiveOnIdle?: boolean
      } = {},
    ): Effect.Effect<boolean | SpawnedBefore> =>
      tx(
        Effect.gen(function* () {
          if (request !== undefined) {
            const before = yield* reads.spawnedBy(project, request)
            if (before !== undefined) return before
          }
          if (max !== undefined) {
            const n = (yield* selectRaw([sql`s.agent != 'main'`, sql`s.ended_at IS NULL`], running)).length
            if (n >= max) return false
          }
          const stopped = row.metadata.archived || row.metadata.removed
          yield* emit(SessionCreated, {
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
          if (archives) yield* sessionLive.archiveWhenIdle(row.id)
          const processAt = row.startedAt ?? row.createdAt
          const process = yield* startProcess(
            row.id,
            {
              harness: row.harnessId,
              ...(row.provider ? { provider: row.provider } : {}),
              ...(row.model ? { model: row.model } : {}),
              ...(row.metadata.routing === undefined ? {} : { routing: row.metadata.routing }),
              runtime: row.runtime,
              terminal: row.address.id,
              ...(row.harnessSessionId ? { resume: row.harnessSessionId } : {}),
            },
            processAt,
          )
          if (row.metadata.pid !== undefined || row.metadata.integration !== undefined)
            yield* emit(ProcessReady, {
              sessionId: row.id,
              at: row.metadata.ready ?? processAt,
              data: {
                process,
                ...(row.metadata.pid === undefined ? {} : { pid: row.metadata.pid }),
                ...(row.metadata.integration === undefined ? {} : { integration: row.metadata.integration }),
              },
            })
          if (row.exitedAt !== null)
            yield* emit(ProcessEnded, { sessionId: row.id, at: row.exitedAt, data: { process, reason: "exited" } })
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
            yield* linkTask(row.id, execution, row.executionPromptedAt)
            if (row.executionState !== "open")
              yield* emit(ExecutionEnded, {
                sessionId: row.id,
                at: row.executionPromptedAt,
                data: { execution, outcome: row.executionState },
              })
          }
          if (stopped)
            yield* emit(SessionEnded, { sessionId: row.id, at: row.lastActive, data: { reason: "archived" } })
          yield* remember(row)
          return true
        }),
      ).pipe(Effect.orDie),

    resolveSession: (input: string, scope?: PeerScope) =>
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

    updateSession: (id: string, patch: SessionPatch) => tx(updateSession(id, patch)).pipe(Effect.orDie),

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

    sessionAt: (runtime: string, address: RuntimeAddress) => sessionAt(runtime, address).pipe(Effect.orDie),

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
      } = {},
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
                yield* emit(SessionEnded, { sessionId: existing.entry, at, data: { reason: "replaced" } })
              }
              yield* emit(SessionCreated, {
                sessionId: id,
                at,
                data: { project, agent: "main", name: "entry", directory: start.projectDirectory ?? "" },
              })
              yield* emit(ProjectEntryChanged, { projectId: project, at, data: { session: id } })
              yield* notify({ type: "live.project", projectId: project })
            }
            const entryId = !existing?.entry || fresh ? id : existing.entry
            if (start.projectDirectory) {
              const [own] = yield* sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${entryId}`
              if (own?.directory === "")
                yield* emit(SessionDirectoryChanged, {
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
            moving.delete(project)
            if (!movingHere || fresh) yield* dropWaiting(project)
            return { sessionId: entryId, harnessSessionId: resume ?? null, projectId: project }
          }),
        )
      }).pipe(Effect.orDie),

    noteConversation: (id: string, conversation: string, process?: number) =>
      tx(store.noteConversation(id, conversation, process)).pipe(Effect.orDie),

    rename: (id: string, name: string) => tx(store.rename(id, name)).pipe(Effect.orDie),

    setStatus: (id: string, status: AgentStatus) => tx(store.setStatus(id, status)).pipe(Effect.orDie),

    placeProcess: (id: string, terminal: string, pid?: number) =>
      tx(store.placeProcess(id, terminal, pid)).pipe(Effect.orDie),

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
            yield* emit(ProcessPid, { sessionId: id, data: { process: current.id, pid: patch.pid as number } })
            return current.id
          }
          if (integration !== undefined) yield* sessionLive.setIntegration(id, integration)
          yield* emit(ProcessReady, {
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
    ...inboxMethods(store),
  }
})

export const SQL_NAMES = { transformQueryNames: Str.camelToSnake, transformResultNames: Str.snakeToCamel } as const

export class Db extends Context.Service<Db, Effect.Success<typeof make>>()("vibest/Db") {
  static readonly layer = Layer.effect(
    Db,
    SqlClient.SqlClient.pipe(
      Effect.andThen(apply),
      Effect.andThen(SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql.unsafe("PRAGMA journal_mode = WAL")))),
      Effect.andThen(SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql.unsafe("PRAGMA synchronous = NORMAL")))),
      Effect.andThen(
        SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql`UPDATE meta SET value = value WHERE key = ''`)),
      ),
      Effect.andThen(make),
    ),
  )

  static readonly node = LayerNode.make({
    service: Db,
    layer: Db.layer,
    deps: [Bus.node, SessionLive.node, PlatformNode.sqlClient],
  })
}
