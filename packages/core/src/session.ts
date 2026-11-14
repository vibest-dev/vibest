import { messageOf } from "@vibest/schema/error"
import type { AgentRefused, PluginsNotActive } from "@vibest/schema/plugin"
import type { RemoveOutcome } from "@vibest/schema/remove"
import {
  AllocationFailed,
  type AmbiguousSession,
  LimitReached,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  RuntimeUnreachable,
  SessionBusy,
  type UnknownAgent,
  HarnessUnavailable,
} from "@vibest/schema/session"
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"

import { type SessionRow, runtimeOf, terminalOf, exitedAt } from "./database/db-rows.ts"
import { Db, type SessionFilter } from "./database/db.ts"
import { LayerNode } from "./effect/layer-node.ts"
import { PlatformNode } from "./effect/platform.ts"
import { Git, type GitState } from "./git.ts"
import { projectRoot, workspaceGit } from "./project/create.ts"
import { Runtimes, RuntimeError } from "./runtimes.ts"
import { Archive } from "./session/archive.ts"
import { Delivery, type SendRefused, unreachable } from "./session/delivery.ts"
import { SessionLive } from "./session/live.ts"
import type { Restarted } from "./session/live.ts"
import { SessionLocks } from "./session/locks.ts"
import { Placement } from "./session/placement.ts"
import { Reconcile } from "./session/reconcile.ts"
import { type Outdated, Restart } from "./session/restart.ts"
import { Spawn, type SpawnInput, type Spawned } from "./session/spawn.ts"
import { gitState, mainCheckout } from "./worktree.ts"

export * as Session from "./session.ts"

export {
  AllocationFailed,
  LaunchFailed,
  LimitReached,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  NotReady,
  RuntimeUnreachable,
  SessionBusy,
} from "@vibest/schema/session"

export { CONFIRM_TIMEOUT, READY_TIMEOUT, STOP_WAIT } from "./session/executions.ts"
export { HOOK_GRACE, START_TIMEOUT } from "./session/reconcile.ts"
export { defaultSessionName, type SpawnInput, type Spawned } from "./session/spawn.ts"

const SESSION_DEPS = [
  Archive.node,
  Db.node,
  Delivery.node,
  Git.node,
  Placement.node,
  Reconcile.node,
  Restart.node,
  Runtimes.node,
  SessionLive.node,
  SessionLocks.node,
  Spawn.node,
  PlatformNode.childProcessSpawner,
  PlatformNode.fileSystem,
  PlatformNode.path,
] as const

interface SessionGit extends GitState {
  readonly unknown?: string
}

const unreadableGit = (error: string): SessionGit => ({
  branch: "",
  pushed: false,
  saved: false,
  why: "",
  unknown: error,
})

export interface SessionView extends SessionRow {
  readonly worktree: string
  readonly repositoryRoot: string | undefined
  readonly git: SessionGit | undefined
}

export interface Interface {
  readonly spawn: (
    input: SpawnInput,
  ) => Effect.Effect<
    Spawned,
    | AllocationFailed
    | LimitReached
    | HarnessUnavailable
    | NoCallingSession
    | UnknownAgent
    | NoHarnessChosen
    | NoRuntime
    | AgentRefused
    | PluginsNotActive
    | NoSuchSession
  >
  readonly send: (id: string, message: string, request?: string, sender?: string) => Effect.Effect<void, NoSuchSession>
  readonly deliverTo: (
    id: string,
    message: string,
    request?: string,
    sender?: string,
  ) => Effect.Effect<void, NoSuchSession>
  readonly admit: (
    sender: { readonly sessionId: string; readonly projectId: string },
    input: string,
    message: string,
    request?: string,
  ) => Effect.Effect<{ readonly id: string }, NoSuchSession | AmbiguousSession | SendRefused>
  readonly interrupt: (
    id: string,
  ) => Effect.Effect<{ message: string }, NoRuntime | NoSuchSession | SessionBusy | RuntimeUnreachable>
  readonly remove: (
    id: string,
    options?: { readonly keepWorktree?: boolean | undefined },
  ) => Effect.Effect<
    RemoveOutcome | undefined,
    NoRuntime | NoSuchSession | SessionBusy | RuntimeUnreachable | RuntimeError
  >
  readonly get: (id: string) => Effect.Effect<SessionView, NoSuchSession>
  readonly peek: (id: string, lines: number) => Effect.Effect<string, NoSuchSession | NoRuntime | RuntimeUnreachable>
  readonly list: (filter?: SessionFilter) => Effect.Effect<ReadonlyArray<SessionView>>
  readonly check: (id: string) => Effect.Effect<void>
  readonly userPrompt: (id: string, text: string, at?: number, process?: number) => Effect.Effect<void>
  readonly typeTaken: (id: string, execution: number) => Effect.Effect<void>
  readonly republish: Effect.Effect<number>
  readonly inMemory: Effect.Effect<{
    readonly tracked: number
    readonly locks: number
    readonly reconciles: number
  }>
  readonly outdated: Effect.Effect<ReadonlyArray<Outdated>>
  readonly restart: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Restarted>>
  readonly restartLater: (ids: ReadonlyArray<string>, after: number | undefined) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("vibest/Sessions") {}

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const runtimes = yield* Runtimes.Service
  const sessionLive = yield* SessionLive
  const locks = yield* SessionLocks
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const git = yield* Git.Service
  const { worktreeOf, republish } = yield* Placement
  const { send, deliverTo, admit, interrupt, userPrompt, typeTaken } = yield* Delivery
  const reconcile = yield* Reconcile
  const { spawn } = yield* Spawn
  const { remove } = yield* Archive
  const { outdated, restart, restartLater } = yield* Restart

  const getRow = (id: string) =>
    db.session
      .getSession(id)
      .pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.fail(new NoSuchSession({ id, message: `no session ${id}` })),
        ),
      )

  const peek = Effect.fn("Session.peek")(function* (id: string, lines: number) {
    const session = yield* getRow(id)
    if (exitedAt(session) !== null || terminalOf(session).id === "")
      return yield* new NoSuchSession({
        id,
        message: `${id} has no terminal to peek at (it exited or never started)`,
      })
    const h = yield* runtimes.route(runtimeOf(session))
    const text = yield* h
      .read(terminalOf(session), Math.max(1, Math.min(Math.floor(lines), 500)))
      .pipe(Effect.catchTag("RuntimeError", unreachable(session)))
    return text.trimEnd()
  })

  const readGit = (session: SessionRow, worktree: string) =>
    Effect.gen(function* () {
      const repos = yield* workspaceGit(worktree)
      if (repos) {
        const unsaved = repos.find((r) => !r.saved)
        const git: GitState = {
          branch: repos.map((r) => `${r.name}=${r.branch}`).join("\n"),
          pushed: repos.every((r) => r.pushed),
          saved: repos.every((r) => r.saved),
          why: unsaved ? `${unsaved.name}: ${unsaved.why}` : "",
        }
        const repositoryRoot = (yield* projectRoot(worktree)).root
        return { ...session, worktree, repositoryRoot, git } satisfies SessionView
      }
      const state = yield* gitState(worktree)
      if (state === undefined)
        return {
          ...session,
          worktree,
          repositoryRoot: undefined,
          git: unreadableGit("git cannot read it"),
        } satisfies SessionView
      const repositoryRoot = yield* mainCheckout(worktree).pipe(Effect.option, Effect.map(Option.getOrUndefined))
      return { ...session, worktree, repositoryRoot, git: state } satisfies SessionView
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          ...session,
          worktree,
          repositoryRoot: undefined,
          git: unreadableGit(messageOf(error)),
        } satisfies SessionView),
      ),
    )

  const view = Effect.fn("Session.view")(
    (session: SessionRow) => worktreeOf(session).pipe(Effect.flatMap((worktree) => readGit(session, worktree))),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(Git.Service, git),
  )

  const unlocated = (session: SessionRow): SessionView => ({
    ...session,
    worktree: "",
    repositoryRoot: undefined,
    git: undefined,
  })

  const get = Effect.fn("Session.get")((id: string) => getRow(id).pipe(Effect.flatMap(view)))
  const list = Effect.fn("Session.list")((filter: SessionFilter = {}) =>
    db.session
      .listSessions(filter)
      .pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            view(row).pipe(Effect.catchTag("NoSuchSession", () => Effect.succeed(unlocated(row)))),
          ),
        ),
      ),
  )

  return Service.of({
    spawn,
    send,
    deliverTo,
    admit,
    interrupt,
    peek,
    remove,
    get,
    list,
    check: reconcile.check,
    typeTaken,
    userPrompt,
    republish: republish(),
    inMemory: Effect.gen(function* () {
      return {
        tracked: (yield* sessionLive.size).tracked,
        locks: yield* locks.size,
        reconciles: yield* reconcile.reconciles,
      }
    }),
    outdated,
    restart,
    restartLater,
  })
})

export const layer = Layer.effect(Service, make)

export const deps = SESSION_DEPS

export const node = LayerNode.make({ service: Service, layer, deps: SESSION_DEPS })
