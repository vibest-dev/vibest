import { projectActivity, unseenDone } from "@vibest/core/activity"
import { type EngineEvent } from "@vibest/core/bus"
import { type CoordinatorRow, Db, encodeAddress, type RuntimeAddress, type SessionBrief } from "@vibest/core/db"
import { coordinatorIdle } from "@vibest/core/inbox"
import type { ListScope } from "@vibest/core/remote"
import { agentState, Runtimes, type Runtime, type Terminal } from "@vibest/core/runtimes"
import { type SessionView, Sessions } from "@vibest/core/sessions"
import { type WatchEvent, type WatchSession, type ProjectRow, type SessionInfo } from "@vibest/protocol/rpc"
import { type AgentStatus } from "@vibest/schema/session"
import { Effect, Option } from "effect"

export const placeOf = (kind: string, address: RuntimeAddress) =>
  address.id !== "" ? `${kind} terminal ${address.id}` : `${kind} (no terminal)`

export const sameCoordinator = (
  current: { readonly runtime: string | null; readonly address: RuntimeAddress | null } | undefined,
  runtime: string,
  address: string,
) => {
  const place = current?.address
  return (
    current?.runtime === runtime &&
    place !== null &&
    place !== undefined &&
    place.id !== "" &&
    encodeAddress(place) === address
  )
}

const LS_TASK = 500
const taskForLs = (task: string | null) =>
  task !== null && task.length > LS_TASK ? `${task.slice(0, LS_TASK - 1)}…` : task

export const toInfo = (session: SessionView, brief?: SessionBrief): SessionInfo => ({
  id: session.id,
  name: session.name,
  agent: session.agent,
  harness: session.harnessId,
  provider: session.provider,
  model: session.model,
  status: session.status,
  startedAt: session.startedAt,
  exitedAt: session.exitedAt,
  turnState: session.turnState,
  projectId: session.projectId,
  runtime: session.runtime,
  address: session.address,
  worktree: session.worktree,
  repositoryRoot: session.repositoryRoot ?? null,
  git: session.git ?? null,
  ...(session.metadata.routing ? { routing: session.metadata.routing } : {}),
  createdAt: session.createdAt,
  lastActive: session.lastActive,
  task: brief?.task ?? null,
  latest: brief?.latest ?? null,
})

const mainInfo = (m: CoordinatorRow, status: AgentStatus): SessionInfo => ({
  id: m.id,
  name: "main",
  agent: "main",
  harness: m.harnessId,
  provider: m.provider,
  model: m.model,
  status,
  startedAt: null,
  exitedAt: null,
  turnState: "none",
  projectId: m.projectId,
  runtime: m.runtime ?? "",
  address: m.address ?? { machine: "local", id: "" },
  worktree: m.projectDirectory ?? "",
  repositoryRoot: m.projectDirectory ?? null,
  git: null,
  ...(m.routing ? { routing: m.routing } : {}),
  createdAt: m.createdAt,
  lastActive: m.createdAt,
  task: null,
  latest: null,
})

const mainStatus = (h: Runtime, terminal: Terminal): Effect.Effect<AgentStatus> =>
  Effect.gen(function* () {
    const seen = yield* agentState(h, terminal).pipe(Effect.option)
    if (Option.isSome(seen) && seen.value !== "absent") return seen.value
    return yield* coordinatorIdle(h, terminal).pipe(
      Effect.map((presence) => (presence === "busy" ? "working" : presence === "idle" ? "idle" : "unknown")),
      Effect.catchTag("RuntimeError", () => Effect.succeed("unknown" as AgentStatus)),
    )
  })

export const sessionListing = (deps: {
  readonly db: Db["Service"]
  readonly sessions: Sessions["Service"]
  readonly runtimes: Runtimes["Service"]
}) => {
  const { db, sessions, runtimes } = deps
  const listedMain = (m: CoordinatorRow | undefined) =>
    Effect.gen(function* () {
      if (!m?.runtime || !m.address || m.address.id === "") return undefined
      const h = yield* runtimes.route(m.runtime).pipe(Effect.option)
      const status = Option.isNone(h) ? "unknown" : yield* mainStatus(h.value, m.address)
      return mainInfo(m, status)
    })

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
      const rows = yield* sessions.list({ ...(projectId === undefined ? {} : { projectId }), stopped })
      const mains = projectId === undefined ? yield* db.coordinators : [yield* db.coordinatorOf(projectId)]
      return [
        ...(yield* Effect.forEach(mains, listedMain)).flatMap((m) => (m ? [m] : [])),
        ...(yield* listedRows(rows)),
      ]
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
            turn: seen?.turn ?? null,
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
      const main = yield* listedMain(yield* db.coordinatorOf(id))
      const live = [
        ...(main === undefined ? [] : [main]),
        ...(yield* db.listSessions({ projectId: id, stopped: false })),
      ]
      return yield* Effect.forEach(
        live,
        (s) => Effect.map(seenAt(s.runtime, s.address), (seen) => unseenDone(s.status, seen)),
        { concurrency: "unbounded" },
      )
    })

  const watchSession = (id: string) =>
    Effect.gen(function* () {
      const identity = yield* db.sessionIdentity(id)
      if (identity === undefined) return []
      const ended: WatchEvent = { _tag: "SessionEnded", id, projectId: identity.projectId }
      const info =
        identity.agent === "coordinator"
          ? yield* listedMain(yield* db.coordinatorOf(identity.projectId))
          : yield* Effect.gen(function* () {
              const row = yield* db.getSession(id)
              if (row === undefined || row.agent === "main" || row.exitedAt !== null) return undefined
              const view = yield* sessions
                .get(id)
                .pipe(
                  Effect.catchTag("NoSuchSession", () =>
                    Effect.succeed({ ...row, worktree: "", repositoryRoot: undefined, git: undefined }),
                  ),
                )
              return (yield* listedRows([view]))[0]
            })
      if (info === undefined || info.id !== id) return [ended]
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
      const project = yield* db.coordinatorAt(runtime, terminal)
      const main = project === undefined ? undefined : yield* db.coordinatorOf(project)
      const rows = yield* db.listSessions()
      return [
        ...(main === undefined ? [] : [main.id]),
        ...rows
          .filter(
            (row) =>
              row.runtime === runtime && row.address.machine === terminal.machine && row.address.id === terminal.id,
          )
          .map((row) => row.id),
      ]
    })

  const watchDeltas = (events: ReadonlyArray<EngineEvent>) =>
    Effect.gen(function* () {
      const projectIds = new Set<string>()
      const sessionIds = new Set<string>()
      for (const event of events) {
        if ("id" in event || event.type === "live.session" || event.type === "live.turn_start")
          sessionIds.add(event.sessionId)
        else if (event.type === "live.project") projectIds.add(event.projectId)
        else if (event.type === "live.state" || event.type === "live.exited") {
          const project = yield* db.coordinatorAt(event.runtime, event.terminal)
          const main = project === undefined ? undefined : yield* db.coordinatorOf(project)
          if (main !== undefined) sessionIds.add(main.id)
        } else if (event.type === "live.seen")
          for (const id of yield* sessionsAt(event.runtime, event.terminal)) sessionIds.add(id)
        else if (event.type === "live.reset")
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
