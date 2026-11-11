import {
  ProcessConversation,
  ProcessEnded,
  ProcessPid,
  ProcessReady,
  ProjectCreated,
  ProjectEntryChanged,
  ProjectMoved,
  ProjectRepositoriesChanged,
  SessionCreated,
  SessionDirectoryChanged,
  SessionEnded,
  TurnEnded,
} from "@vibest/schema/event"
import { newId } from "@vibest/schema/id"
import { AmbiguousSession, NoSuchSession, RuntimeAddress } from "@vibest/schema/session"
import { Context, Effect, Layer, String as Str } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "./bus.ts"
import { apply } from "./database/migration.ts"
import { inboxMethods } from "./db-inbox.ts"
import { remoteQueries, type PeerStart } from "./db-remote.ts"
import {
  SessionRow,
  type EndReason,
  type SessionPatch,
  type SpawnedBefore,
  type RepositoryRow,
  type Integration,
} from "./db-rows.ts"
import { makeStore } from "./db-store.ts"
import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"
import type { HarnessId } from "./harness.ts"

export type { MachineRow, OutboxRow, PeerStart } from "./db-remote.ts"
export { RuntimeAddress, InboxKind, InboxRow, InboxStatus, AgentStatus, TurnState } from "@vibest/schema/session"
export {
  AddressJson,
  encodeAddress,
  SessionRow,
  type EndReason,
  type SessionPatch,
  CoordinatorRow,
  type NewInboxRow,
  type SpawnedBefore,
  type RepositoryRow,
  type TurnEnd,
  type TurnReport,
  failureOf,
  type SessionBrief,
} from "./db-rows.ts"
export { APPLICATION_ID, DatabaseOpenFailed, SchemaMismatch, inspectSchema } from "./db-schema.ts"

export type SessionFilter = {
  readonly projectId?: string
  readonly stopped?: boolean
  readonly peer?: { readonly peer: string; readonly project: string } | undefined
}

const make = Effect.gen(function* () {
  const store = yield* makeStore
  const {
    sql,
    reads,
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
    readSession,
    currentProcess,
    findCoordinators,
    queueInbox,
    linkTask,
    endProcess,
    startProcess,
    startTurn,
    updateSession,
    dropWaiting,
    sessionAt,
    mainsAt,
    clearMainAt,
    unusedId,
    conversationOf,
  } = store
  const remote = remoteQueries(store)
  const canResumeConversation = (sessionId: string, harnessSessionId: string) =>
    sql<{ ok: number }>`SELECT (
      EXISTS (
        SELECT 1 FROM turn t JOIN process p ON p.id = t.process_id
        WHERE t.session_id = ${sessionId} AND t.status IS NOT NULL
          AND (p.resume = ${harnessSessionId} OR p.conversation = ${harnessSessionId})
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

    creatorOf: (id: string) =>
      sql<{
        creator: string | null
        origin: string | null
        entry: string | null
        name: string | null
      }>`SELECT s.report_to_session_id AS creator, s.origin_report_to AS origin, p.entry_session_id AS entry,
          c.name AS name
        FROM session s JOIN project p ON p.id = s.project_id LEFT JOIN session c ON c.id = s.report_to_session_id
        WHERE s.id = ${id}`.pipe(
        Effect.map(([row]) => {
          const creator = row?.creator ?? row?.origin ?? row?.entry
          if (creator === null || creator === undefined) return undefined
          const label =
            creator === row?.entry ? "the main agent" : row?.name ? `agent ${row.name}` : "the agent that started you"
          return { id: creator, label }
        }),
        Effect.orDie,
      ),

    insertSession: (
      row: Omit<SessionRow, "projectId">,
      project: string,
      {
        max,
        cwd = "",
        task,
        parentSessionId,
        request,
        origin,
      }: {
        readonly max?: number | undefined
        readonly cwd?: string
        readonly task?: string
        readonly parentSessionId?: string | undefined
        readonly request?: string | undefined
        readonly origin?: PeerStart | undefined
      } = {},
    ): Effect.Effect<boolean | SpawnedBefore> =>
      tx(
        Effect.gen(function* () {
          if (request !== undefined) {
            const before = yield* reads.spawnedBy(project, request)
            if (before !== undefined) return before
          }
          if (max !== undefined) {
            const n = (yield* selectRaw([notMain, sql`s.ended_at IS NULL`], running)).length
            if (n >= max) return false
          }
          const [entry] =
            origin === undefined && parentSessionId === undefined && row.agent !== "main"
              ? yield* sql<{ id: string | null }>`SELECT entry_session_id AS id FROM project WHERE id = ${project}`
              : []
          const reportTo = parentSessionId ?? entry?.id ?? undefined
          const stopped = row.metadata.archived || row.metadata.removed
          yield* emit(SessionCreated, {
            sessionId: row.id,
            projectId: project,
            at: row.createdAt,
            data: {
              role: row.agent,
              name: row.name,
              directory: cwd,
              ...(parentSessionId === undefined ? {} : { parent: parentSessionId }),
              ...(reportTo === undefined ? {} : { reportTo }),
              archiveOnCompletion: row.metadata.archive === true,
              ...(origin === undefined
                ? {}
                : {
                    origin: {
                      peer: origin.peer,
                      project: origin.project,
                      ...(origin.parent === undefined ? {} : { parent: origin.parent }),
                      ...(origin.reportTo === undefined ? {} : { reportTo: origin.reportTo }),
                    },
                  }),
            },
          })
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
          if (row.turnState !== "none") {
            const turn = yield* startTurn(row.id, row.turnPromptedAt)
            yield* linkTask(row.id, turn, row.turnPromptedAt)
            if (row.turnState !== "open")
              yield* emit(TurnEnded, {
                sessionId: row.id,
                at: row.turnPromptedAt,
                data: { turn, status: row.turnState },
              })
          }
          if (stopped)
            yield* emit(SessionEnded, { sessionId: row.id, at: row.lastActive, data: { reason: "archived" } })
          remember(row)
          return true
        }),
      ).pipe(Effect.orDie),

    resolveSession: (input: string, scope?: { readonly peer: string; readonly project: string }) =>
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
      sql<{ id: string; projectId: string; agent: string; harness: string }>`SELECT a.id, a.project_id,
          coalesce(p.harness, '') AS harness,
          CASE WHEN q.entry_session_id = a.id THEN 'coordinator' ELSE a.role END AS agent
        FROM session a JOIN project q ON q.id = a.project_id
        LEFT JOIN process p ON p.id = a.process_id
        WHERE a.id = ${id}`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    getSession: (id: string) => readSession(id).pipe(Effect.orDie),

    liveStatuses: Effect.sync(() => statuses.size),

    updateSession: (id: string, patch: SessionPatch) => tx(updateSession(id, patch)).pipe(Effect.orDie),

    listSessions: (filter: SessionFilter = {}) =>
      selectSessions(
        [
          ...(filter.projectId === undefined ? [] : [sql`s.project_id = ${filter.projectId}`]),
          ...(filter.peer === undefined ? [] : [remote.ofPeer(sql`s.id`, filter.peer)]),
        ],
        filter.stopped === true,
        filter.stopped ? undefined : running,
      ).pipe(Effect.orDie),

    sessionBriefs: (ids: ReadonlyArray<string>) => reads.briefs(ids).pipe(Effect.orDie),

    coordinators: findCoordinators().pipe(Effect.orDie),

    allocateSessionId: () => unusedId,

    coordinatorOf: (projectIdValue: string) =>
      findCoordinators(projectIdValue).pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    coordinatorAt: (runtime: string, address: RuntimeAddress) =>
      mainsAt(runtime, address).pipe(
        Effect.map((rows) => rows[0]?.project),
        Effect.orDie,
      ),

    sessionAt: (runtime: string, address: RuntimeAddress) => sessionAt(runtime, address).pipe(Effect.orDie),

    coordinatorLaunch: (
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
            yield* clearMainAt(location.runtime, location.address, project)
            const movingHere = moving.has(project)
            const [existing] = yield* sql<{
              main: string | null
            }>`SELECT entry_session_id AS main FROM project WHERE id = ${project}`
            const at = yield* now
            if (!existing?.main || fresh) {
              if (existing?.main) {
                yield* endProcess(existing.main, "archived", at)
                yield* emit(SessionEnded, { sessionId: existing.main, at, data: { reason: "replaced" } })
              }
              yield* emit(SessionCreated, {
                sessionId: id,
                projectId: project,
                at,
                data: {
                  role: "main",
                  name: "main",
                  directory: start.projectDirectory ?? "",
                  archiveOnCompletion: false,
                },
              })
              yield* emit(ProjectEntryChanged, { projectId: project, at, data: { session: id } })
              yield* notify({ type: "live.project", projectId: project })
            }
            const mainId = !existing?.main || fresh ? id : existing.main
            if (start.projectDirectory) {
              const [own] = yield* sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${mainId}`
              if (own?.directory === "")
                yield* emit(SessionDirectoryChanged, {
                  sessionId: mainId,
                  at,
                  data: { directory: start.projectDirectory },
                })
            }
            const { current, conversation } = yield* conversationOf(mainId)
            if (current !== undefined && current.ended === null)
              yield* endProcess(mainId, movingHere ? "move" : "exited", at)
            const resume =
              !fresh &&
              current?.start.harness === harness &&
              conversation !== null &&
              (yield* canResumeConversation(mainId, conversation))
                ? conversation
                : undefined
            yield* startProcess(
              mainId,
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
            return { sessionId: mainId, harnessSessionId: resume ?? null, projectId: project }
          }),
        )
      }).pipe(Effect.orDie),

    noteHarnessSession: (id: string, harnessSessionId: string) =>
      tx(
        Effect.gen(function* () {
          const { current, conversation } = yield* conversationOf(id)
          if (current === undefined || conversation === harnessSessionId) return false
          yield* emit(ProcessConversation, {
            sessionId: id,
            data: { process: current.id, conversation: harnessSessionId },
          })
          return true
        }),
      ).pipe(Effect.orDie),

    noteIntegration: (id: string, integration: Integration) =>
      Effect.gen(function* () {
        const exists = yield* sql`SELECT 1 FROM session WHERE id = ${id}`
        if (exists.length === 0) return false
        const known = integrations.get(id) ?? (yield* currentProcess(id))?.integration
        if (known?.version === integration.version && known.protocol === integration.protocol) return false
        integrations.set(id, integration)
        return true
      }).pipe(Effect.orDie),

    patchLive: (
      id: string,
      patch: {
        readonly pid?: number | null
        readonly ready?: number | null
        readonly integration?: Integration
      },
    ) =>
      tx(
        Effect.gen(function* () {
          const ready = typeof patch.ready === "number"
          if (!ready && typeof patch.pid !== "number") return
          const current = yield* currentProcess(id)
          if (current === undefined) return
          const integration = patch.integration ?? integrations.get(id)
          if (!ready) {
            yield* emit(ProcessPid, { sessionId: id, data: { process: current.id, pid: patch.pid as number } })
            return
          }
          if (integration !== undefined) integrations.set(id, integration)
          yield* emit(ProcessReady, {
            sessionId: id,
            at: patch.ready as number,
            data: {
              process: current.id,
              ...(typeof patch.pid === "number" ? { pid: patch.pid } : {}),
              ...(integration === undefined ? {} : { integration }),
            },
          })
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

    endProcess: (id: string, reason: EndReason) => tx(endProcess(id, reason)).pipe(Effect.orDie),

    reportCoordinatorSession: (sessionId: string, harness: HarnessId, harnessSessionId: string) =>
      tx(
        Effect.gen(function* () {
          const [main] = yield* sql<{
            id: string
          }>`SELECT entry_session_id AS id FROM project WHERE entry_session_id = ${sessionId}`
          const { current, conversation } = yield* conversationOf(sessionId)
          if (main === undefined || current === undefined || current.start.harness !== harness)
            return yield* Effect.logDebug(`main agent session report ignored for ${sessionId}`)
          if (conversation === harnessSessionId) return
          yield* emit(ProcessConversation, {
            sessionId,
            data: { process: current.id, conversation: harnessSessionId },
          })
        }),
      ).pipe(Effect.orDie),

    detachCoordinator: (projectIdValue: string, runtime: string, address: RuntimeAddress) =>
      Effect.gen(function* () {
        const here = (yield* mainsAt(runtime, address)).some((m) => m.project === projectIdValue)
        if (here) moving.add(projectIdValue)
        return here
      }).pipe(Effect.orDie),

    reattachCoordinator: (projectIdValue: string, _runtime: string, _address: RuntimeAddress) =>
      Effect.sync(() => {
        moving.delete(projectIdValue)
      }),

    clearCoordinator: (runtime: string, address: RuntimeAddress) =>
      tx(clearMainAt(runtime, address)).pipe(Effect.asVoid, Effect.orDie),

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

  static readonly node = LayerNode.make({ service: Db, layer: Db.layer, deps: [Bus.node, PlatformNode.sqlClient] })
}
