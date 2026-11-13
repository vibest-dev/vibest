import { type BusEvent } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import {
  executionStateOf,
  exitedAt,
  harnessIdOf,
  runtimeOf,
  type SessionBrief,
  terminalOf,
} from "@vibest/core/database/db-rows"
import { projectActivity, unseenDone } from "@vibest/core/project/activity"
import { Runtimes } from "@vibest/core/runtimes"
import { type SessionView, Sessions } from "@vibest/core/session"
import { type WatchEvent, type WatchSession, type ProjectRow, type SessionInfo } from "@vibest/protocol/rpc"
import type { RuntimeAddress } from "@vibest/schema/session"
import { Effect } from "effect"

import type { ListScope } from "./machine/remote.ts"

const LS_TASK = 500
const taskForLs = (task: string | null) =>
  task !== null && task.length > LS_TASK ? `${task.slice(0, LS_TASK - 1)}…` : task

export const toInfo = (session: SessionView, brief?: SessionBrief): SessionInfo => ({
  id: session.id,
  name: session.name,
  agent: session.agent,
  harness: harnessIdOf(session),
  provider: session.process?.provider ?? null,
  model: session.process?.model ?? null,
  status: session.status,
  startedAt: session.process?.placedAt ?? null,
  exitedAt: exitedAt(session),
  executionState: executionStateOf(session),
  projectId: session.projectId,
  runtime: runtimeOf(session),
  address: terminalOf(session),
  worktree: session.worktree,
  repositoryRoot: session.repositoryRoot ?? null,
  git: session.git ?? null,
  ...(session.process?.routing ? { routing: session.process.routing } : {}),
  createdAt: session.createdAt,
  lastActive: session.lastActive,
  task: brief?.task ?? null,
  latest: brief?.latest ?? null,
})

export const sessionListing = (deps: {
  readonly db: Db["Service"]
  readonly sessions: Sessions["Service"]
  readonly runtimes: Runtimes["Service"]
}) => {
  const { db, sessions, runtimes } = deps
  const listedRows = (rows: ReadonlyArray<SessionView>) =>
    Effect.map(db.sessionBriefs(rows.map((row) => row.id)), (briefs) =>
      rows.map((row) => {
        const brief = briefs.get(row.id)
        return { ...toInfo(row, brief), task: taskForLs(brief?.task ?? null) }
      }),
    )

  const listed = (scope: ListScope, stopped: boolean) =>
    Effect.gen(function* () {
      if (scope._tag === "Nothing") return []
      if (scope._tag === "Peer") return yield* listedRows(yield* sessions.list({ peer: scope, stopped }))
      const projectId = scope._tag === "Project" ? scope.id : undefined
      return yield* listedRows(yield* sessions.list({ ...(projectId === undefined ? {} : { projectId }), stopped }))
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
      const parents = yield* db.sessionParents(infos.map((info) => info.id))
      return yield* Effect.forEach(
        infos,
        (info) =>
          Effect.map(seenAt(info.runtime, info.address), (seen): WatchSession => ({
            ...info,
            status: unseenDone(info.status, seen),
            parentId: parents.get(info.id) ?? null,
            finished: seen?.finished ?? null,
          })),
        { concurrency: "unbounded" },
      )
    })

  const snapshotProjects = (sessions: ReadonlyArray<WatchSession>) =>
    Effect.map(db.watchProjects(), (rows) =>
      rows.map((row): ProjectRow => ({
        ...row,
        activity: projectActivity(sessions.filter((s) => s.projectId === row.id).map((s) => s.status)),
      })),
    )

  const projectStatuses = (id: string) =>
    Effect.gen(function* () {
      return yield* Effect.forEach(
        yield* db.listSessions({ projectId: id, stopped: false }),
        (s) => Effect.map(seenAt(runtimeOf(s), terminalOf(s)), (seen) => unseenDone(s.status, seen)),
        { concurrency: "unbounded" },
      )
    })

  const watchSession = (id: string) =>
    Effect.gen(function* () {
      const identity = yield* db.sessionIdentity(id)
      if (identity === undefined) return []
      const ended: WatchEvent = { _tag: "SessionEnded", id, projectId: identity.projectId }
      const row = yield* db.getSession(id)
      if (row === undefined || exitedAt(row) !== null) return [ended]
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
      return [{ _tag: "Session", session: session! } satisfies WatchEvent]
    })

  const watchProject = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* db.watchProjects(id)
      if (rows.length === 0) return []
      const activity = projectActivity(yield* projectStatuses(id))
      return rows.map((row): WatchEvent => ({ _tag: "Project", project: { ...row, activity } }))
    })

  const sessionsAt = (runtime: string, terminal: RuntimeAddress) =>
    Effect.gen(function* () {
      const rows = yield* db.listSessions()
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
        else if (event.type === "project.changed") projectIds.add(event.projectId)
        else if (event.type === "terminal.state" || event.type === "terminal.exited") {
          const project = yield* db.entryAt(event.runtime, event.terminal)
          const entry = project === undefined ? undefined : yield* db.entryOf(project)
          if (entry !== undefined) sessionIds.add(entry.id)
        } else if (event.type === "terminal.seen")
          for (const id of yield* sessionsAt(event.runtime, event.terminal)) sessionIds.add(id)
        else if (event.type === "runtime.reset")
          for (const info of yield* listed({ _tag: "All" }, false))
            if (info.runtime === event.runtime) sessionIds.add(info.id)
      }
      for (const id of sessionIds) {
        const identity = yield* db.sessionIdentity(id)
        if (identity !== undefined) projectIds.add(identity.projectId)
      }
      return [
        ...(yield* Effect.forEach(sessionIds, watchSession)).flat(),
        ...(yield* Effect.forEach(projectIds, watchProject)).flat(),
      ]
    })

  return { listed, watched, snapshotProjects, watchDeltas }
}

export type Listing = ReturnType<typeof sessionListing>
