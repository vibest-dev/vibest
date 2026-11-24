import { type BusEvent } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import {
  archived,
  executionStateOf,
  exitedAt,
  harnessIdOf,
  type ProcessStart,
  runtimeOf,
  type SessionBrief,
  terminalOf,
} from "@vibest/core/database/db-rows"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Project } from "@vibest/core/project"
import { projectActivity, unseenDone } from "@vibest/core/project/activity"
import { Runtimes } from "@vibest/core/runtimes"
import { type SessionView, Session } from "@vibest/core/session"
import { Starts } from "@vibest/core/session/starts"
import {
  type ProjectRepository,
  type ProjectRow,
  type SessionInfo,
  type WatchEvent,
  type WatchSession,
} from "@vibest/protocol/rpc"
import type { RuntimeAddress } from "@vibest/schema/session"
import { Context, Data, Effect, Layer, Predicate } from "effect"

import { ListScope } from "./machine/remote.ts"

export const WatchEvents = Data.taggedEnum<WatchEvent>()

const LS_TASK = 500

const taskForLs = (task: string | null) =>
  task !== null && task.length > LS_TASK ? `${task.slice(0, LS_TASK - 1)}…` : task

export const toInfo = (session: SessionView, brief?: SessionBrief, waiting?: ProcessStart): SessionInfo => ({
  id: session.id,
  name: session.name,
  agent: session.agent,
  harness: session.process === null && waiting !== undefined ? waiting.harness : harnessIdOf(session),
  provider: session.process?.provider ?? waiting?.provider ?? null,
  model: session.process?.model ?? waiting?.model ?? null,
  status: session.status,
  startedAt: session.process?.placedAt ?? null,
  exitedAt: exitedAt(session),
  executionState: executionStateOf(session),
  projectId: session.projectId,
  runtime: session.process === null && waiting !== undefined ? waiting.runtime : runtimeOf(session),
  address: exitedAt(session) !== null ? { machine: "local", id: "" } : terminalOf(session),
  worktree: session.worktree,
  repositoryRoot: session.repositoryRoot ?? null,
  git: session.git ?? null,
  ...(session.process?.routing && { routing: session.process.routing }),
  createdAt: session.createdAt,
  lastActive: session.lastActive,
  task: brief?.task ?? null,
  latest: brief?.latest ?? null,
  ...(waiting !== undefined && { waitingToStart: true as const }),
})

interface CachedRepositories {
  readonly directory: string | null
  readonly repositories: ReadonlyArray<ProjectRepository>
}

export const sessionListing = (deps: {
  readonly db: Db.Interface
  readonly projects: Project.Interface
  readonly sessions: Session.Interface
  readonly runtimes: Runtimes.Interface
  readonly starts: Starts.Interface
}) => {
  const { db, projects, sessions, runtimes, starts } = deps
  const repositoryCache = new Map<string, CachedRepositories>()

  const resolveRepositories = (id: string, directory: string | null, refresh: boolean) =>
    Effect.gen(function* () {
      const hit = repositoryCache.get(id)

      if (!refresh && hit !== undefined && hit.directory === directory) return hit.repositories

      const recorded = yield* db.project.projectRemote(id)
      const repositories = yield* projects.repositories(directory, recorded)
      repositoryCache.set(id, { directory, repositories })

      return repositories
    })

  const listedRows = (rows: ReadonlyArray<SessionView>) =>
    Effect.gen(function* () {
      const briefs = yield* db.session.sessionBriefs(rows.map((row) => row.id))
      const waiting = yield* starts.choices

      return rows.map((row) => {
        const brief = briefs.get(row.id)

        return { ...toInfo(row, brief, waiting.get(row.id)), task: taskForLs(brief?.task ?? null) }
      })
    })

  const listed = (scope: ListScope, stopped: boolean, unarchived = false) =>
    Effect.gen(function* () {
      if (Predicate.isTagged(scope, "Nothing")) return []

      const waiting = yield* starts.waiting

      if (Predicate.isTagged(scope, "Remote"))
        return yield* listedRows(yield* sessions.list({ remote: scope, stopped, unarchived, waiting }))
      const projectId = Predicate.isTagged(scope, "Project") ? scope.id : undefined

      return yield* listedRows(
        yield* sessions.list({ ...(projectId !== undefined && { projectId }), stopped, unarchived, waiting }),
      )
    })

  const seenAt = (runtime: string, address: RuntimeAddress) =>
    address.id === ""
      ? Effect.succeed(undefined)
      : runtimes.route(runtime).pipe(
          Effect.flatMap((rt) => (rt.seen === undefined ? Effect.succeed(undefined) : rt.seen(address))),
          Effect.orElseSucceed(() => undefined),
        )

  const watched = (infos: ReadonlyArray<SessionInfo>) =>
    Effect.gen(function* () {
      const ids = infos.map((info) => info.id)
      const parents = yield* db.session.sessionParents(ids)
      const edges = yield* db.session.sessionEdges(ids)

      return yield* Effect.forEach(
        infos,
        (info) =>
          Effect.map(seenAt(info.runtime, info.address), (seen): WatchSession => ({
            ...info,
            status: unseenDone(info.status, seen),
            parentId: parents.get(info.id) ?? null,
            finished: seen?.finished ?? null,
            to: edges.get(info.id) ?? [],
          })),
        { concurrency: "unbounded" },
      )
    })

  const snapshotProjects = (sessions: ReadonlyArray<WatchSession>) =>
    Effect.flatMap(db.project.watchProjects(), (rows) =>
      Effect.forEach(
        rows,
        (row) =>
          Effect.map(resolveRepositories(row.id, row.directory, true), (repositories): ProjectRow => ({
            ...row,
            activity: projectActivity(
              sessions.flatMap((s) => (s.projectId === row.id && s.exitedAt === null ? [s.status] : [])),
            ),
            repositories,
          })),
        { concurrency: 8 },
      ),
    )

  const projectStatuses = (id: string) =>
    Effect.gen(function* () {
      return yield* Effect.forEach(
        yield* db.session.listSessions({ projectId: id, stopped: false }),
        (s) => Effect.map(seenAt(runtimeOf(s), terminalOf(s)), (seen) => unseenDone(s.status, seen)),
        { concurrency: "unbounded" },
      )
    })

  const watchSession = (id: string) =>
    Effect.gen(function* () {
      const identity = yield* db.session.sessionIdentity(id)

      if (identity === undefined) return []
      const ended = WatchEvents.SessionEnded({ id, projectId: identity.projectId })
      const row = yield* db.session.getSession(id)

      if (row === undefined || archived(row)) return [ended]

      const view = yield* sessions
        .get(id)
        .pipe(
          Effect.catchTag("NoSuchSession", () =>
            Effect.succeed({ ...row, worktree: "", repositoryRoot: undefined, git: undefined }),
          ),
        )

      const info = (yield* listedRows([view]))[0]

      if (info === undefined) return [ended]
      const [session] = yield* watched([info])

      return [WatchEvents.Session({ session: session! })]
    })

  const watchProject = (id: string) =>
    Effect.gen(function* () {
      const [row] = yield* db.project.watchProjects(id)

      if (row === undefined) return []
      const activity = projectActivity(yield* projectStatuses(id))
      const repositories = yield* resolveRepositories(row.id, row.directory, false)

      return [WatchEvents.Project({ project: { ...row, activity, repositories } })]
    })

  const sessionsAt = (runtime: string, terminal: RuntimeAddress) =>
    Effect.gen(function* () {
      const rows = yield* db.session.listSessions()

      return rows
        .filter(
          (row) =>
            runtimeOf(row) === runtime &&
            terminalOf(row).machine === terminal.machine &&
            terminalOf(row).id === terminal.id,
        )
        .map((row) => row.id)
    })

  const watchDeltas = (events: ReadonlyArray<BusEvent>) =>
    Effect.gen(function* () {
      const projectIds = new Set<string>()
      const sessionIds = new Set<string>()

      for (const event of events) {
        if (event.type === "session.changed") sessionIds.add(event.sessionId)
        else if (event.type === "project.changed") {
          repositoryCache.delete(event.projectId)
          projectIds.add(event.projectId)
        } else if (
          event.type === "terminal.state" ||
          event.type === "terminal.exited" ||
          event.type === "terminal.seen"
        )
          for (const id of yield* sessionsAt(event.runtime, event.terminal)) sessionIds.add(id)
        else if (event.type === "runtime.reset")
          for (const info of yield* listed(ListScope.All(), false))
            if (info.runtime === event.runtime) sessionIds.add(info.id)
      }

      for (const id of sessionIds) {
        const identity = yield* db.session.sessionIdentity(id)

        if (identity !== undefined) projectIds.add(identity.projectId)
      }

      return [
        ...(yield* Effect.forEach(sessionIds, watchSession)).flat(),
        ...(yield* Effect.forEach(projectIds, watchProject)).flat(),
      ]
    })

  return { listed, watched, snapshotProjects, watchDeltas }
}

export type Interface = ReturnType<typeof sessionListing>

export class Service extends Context.Service<Service, Interface>()("vibest/Listing") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return sessionListing({
      db: yield* Db.Service,
      projects: yield* Project.Service,
      sessions: yield* Session.Service,
      runtimes: yield* Runtimes.Service,
      starts: yield* Starts.Service,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Db.node, Project.node, Session.node, Runtimes.node, Starts.node],
})
