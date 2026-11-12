import type { AgentRefused } from "@vibest/schema/plugin"
import {
  AllocationFailed,
  LimitReached,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  RuntimeUnreachable,
  SessionBusy,
  type UnknownAgent,
} from "@vibest/schema/session"
import { Context, Effect, FileSystem, Layer, Option, Path, Ref } from "effect"

import { Agents } from "./agents.ts"
import { Bus } from "./bus.ts"
import { Db, type SessionFilter, type SessionRow } from "./db.ts"
import { Drain } from "./drain.ts"
import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"
import { Harness, Harnesses, HarnessUnavailable } from "./harness.ts"
import { Inbox, text as inboxText } from "./inbox.ts"
import { entryCommand, restartArgv } from "./launch.ts"
import { Layout, VibestCommand } from "./paths.ts"
import { Plugins } from "./plugins.ts"
import { Processes } from "./processes.ts"
import { projectRoot, workspaceGit } from "./project-create.ts"
import * as Remove from "./remove.ts"
import { type Outdated, type Restarted, sessionRestart } from "./restart.ts"
import { Runtimes, RuntimeError } from "./runtimes.ts"
import type { Platform } from "./session-types.ts"
import { Archive } from "./session/archive.ts"
import { Delivery, unreachable } from "./session/delivery.ts"
import { Executions } from "./session/executions.ts"
import { SessionLive } from "./session/live.ts"
import { SessionLocks } from "./session/locks.ts"
import { Placement, runtimeEnv } from "./session/placement.ts"
import { Reconcile } from "./session/reconcile.ts"
import { Spawn, type SpawnInput, type Spawned } from "./session/spawn.ts"
import { Git, gitState, type GitState, mainCheckout } from "./worktree.ts"

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
export {
  allocationNameSource,
  defaultSessionName,
  shareAdmitPause,
  type SpawnInput,
  type Spawned,
} from "./session/spawn.ts"

export const TAIL_LINES = 30

const SESSION_DEPS = [
  Agents.node,
  Archive.node,
  Bus.node,
  Db.node,
  Delivery.node,
  Drain.node,
  Executions.node,
  Git.node,
  Harness.node,
  Harnesses.node,
  Inbox.node,
  Placement.node,
  Plugins.node,
  Processes.node,
  Reconcile.node,
  Runtimes.node,
  SessionLive.node,
  SessionLocks.node,
  Spawn.node,
  PlatformNode.childProcessSpawner,
  PlatformNode.crypto,
  PlatformNode.fileSystem,
  PlatformNode.layout,
  PlatformNode.path,
] as const

export interface SessionView extends SessionRow {
  readonly worktree: string
  readonly repositoryRoot: string | undefined
  readonly git: GitState | undefined
}

export class Sessions extends Context.Service<
  Sessions,
  {
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
      | NoSuchSession
    >
    readonly send: (
      id: string,
      message: string,
      request?: string,
      sender?: string,
    ) => Effect.Effect<void, NoSuchSession>
    readonly interrupt: (
      id: string,
    ) => Effect.Effect<{ message: string }, NoRuntime | NoSuchSession | SessionBusy | RuntimeUnreachable>
    readonly remove: (
      id: string,
      options?: { readonly keepWorktree?: boolean | undefined },
    ) => Effect.Effect<
      Remove.RemoveOutcome | undefined,
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
>()("vibest/Sessions") {
  static readonly make = Effect.gen(function* () {
    const db = yield* Db
    const runtimes = yield* Runtimes
    const harness = yield* Harness
    const harnesses = yield* Harnesses
    const agents = yield* Agents
    const inbox = yield* Inbox
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const processes = yield* Processes
    const sessionLive = yield* SessionLive
    const { restarting, track } = sessionLive
    const bus = yield* Bus
    const platform = yield* Effect.context<Platform>()
    const scope = yield* Effect.scope

    const locks = yield* SessionLocks
    const locked = locks.locked

    const live = (session: SessionRow) => runtimes.route(session.runtime)

    const { awaitReady, prompt } = yield* Executions
    const { worktreeOf, launchArgv, republish } = yield* Placement

    const delivery = yield* Delivery
    const reconcile = yield* Reconcile
    const { send, interrupt, userPrompt } = delivery

    const { spawn } = yield* Spawn

    const getRow = (id: string) =>
      db
        .getSession(id)
        .pipe(
          Effect.flatMap((session) =>
            session ? Effect.succeed(session) : Effect.fail(new NoSuchSession({ id, message: `no session ${id}` })),
          ),
        )

    const { remove } = yield* Archive

    const typeTaken = (id: string, execution: number) =>
      locks.withLock(id)(
        Effect.gen(function* () {
          const session = yield* db.getSession(id)
          if (session === undefined) return
          const r = yield* track(id)
          const rows = yield* db.unacceptedBatch(id, execution)
          if (rows === undefined || rows.length === 0 || !(yield* inbox.claimRetype(id, execution))) return
          const h = yield* live(session)
          yield* Ref.set(r.prompting, true).pipe(
            Effect.andThen(h.send(session.address, { text: inboxText(rows) })),
            Effect.ensuring(Ref.set(r.prompting, false)),
            Effect.ignore,
          )
        }).pipe(
          Effect.catchTag("NoRuntime", () => Effect.void),
          Effect.provideContext(platform),
        ),
      )

    const peek = (id: string, lines: number) =>
      Effect.gen(function* () {
        const session = yield* getRow(id)
        if (session.exitedAt !== null || session.address.id === "")
          return yield* new NoSuchSession({
            id,
            message: `${id} has no terminal to peek at (it exited or never started)`,
          })
        const h = yield* live(session)
        const text = yield* h
          .read(session.address, Math.max(1, Math.min(Math.floor(lines), 500)))
          .pipe(Effect.catchTag("RuntimeError", unreachable(session)))
        return text.trimEnd()
      })

    const view = (session: SessionRow) =>
      session.entry
        ? Effect.map(db.sessionDirectory(session.id), (directory) => ({
            ...session,
            worktree: directory ?? "",
            repositoryRoot: directory,
            git: undefined,
          }))
        : Effect.gen(function* () {
            const worktree = yield* worktreeOf(session)
            const repos = yield* workspaceGit(worktree).pipe(Effect.orDie)
            if (repos) {
              const unsaved = repos.find((r) => !r.saved)
              const git: GitState = {
                branch: repos.map((r) => `${r.name}=${r.branch}`).join("\n"),
                pushed: repos.every((r) => r.pushed),
                saved: repos.every((r) => r.saved),
                why: unsaved ? `${unsaved.name}: ${unsaved.why}` : "",
              }
              const repositoryRoot = (yield* projectRoot(worktree).pipe(Effect.orDie)).root
              return { ...session, worktree, repositoryRoot, git } satisfies SessionView
            }
            const g = yield* gitState(worktree).pipe(Effect.orDie)
            const repositoryRoot = g
              ? yield* mainCheckout(worktree).pipe(Effect.option, Effect.map(Option.getOrUndefined))
              : undefined
            return { ...session, worktree, repositoryRoot, git: g } satisfies SessionView
          })

    const unlocated = (session: SessionRow): SessionView => ({
      ...session,
      worktree: "",
      repositoryRoot: undefined,
      git: undefined,
    })

    const get = (id: string) => getRow(id).pipe(Effect.flatMap(view), Effect.provideContext(platform))
    const list = (filter: SessionFilter = {}) =>
      db.listSessions(filter).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            view(row).pipe(Effect.catchTag("NoSuchSession", () => Effect.succeed(unlocated(row)))),
          ),
        ),
        Effect.provideContext(platform),
      )

    const vibestCommand = yield* VibestCommand
    const { outdated, restart, restartLater } = sessionRestart({
      db,
      bus,
      runtimes,
      harnesses,
      processes,
      restarting,
      scope,
      locked: (id) => locked(id),
      checkLater: (id) => Effect.forkIn(reconcile.check(id), scope).pipe(Effect.asVoid),
      launchArgv,
      entryArgv: (entry) =>
        Effect.gen(function* () {
          yield* db.patchLive(entry.id, { ready: null })
          const root = entry.projectDirectory ?? (yield* db.projectDirectory(entry.projectId)) ?? ""
          const savedId = entry.harnessSessionId
          const command = yield* entryCommand({
            harness: entry.harnessId,
            agent: entry.agent,
            root,
            provider: entry.provider,
            model: entry.model,
            session: Effect.succeed({
              sessionId: entry.id,
              harnessSessionId:
                savedId !== null && (yield* db.canResumeConversation(entry.id, savedId)) ? savedId : null,
              projectId: entry.projectId,
              ...(entry.runtime && entry.address ? { runtime: runtimeEnv(entry.runtime, entry.address) } : {}),
            }),
          })
          return restartArgv(command)
        }).pipe(
          Effect.provideService(Agents, agents),
          Effect.provideService(Harness, harness),
          Effect.provideService(Harnesses, harnesses),
          Effect.provideService(Layout, layout),
          Effect.provideService(VibestCommand, vibestCommand),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      awaitReady,
      prompt: (h, session, terminal, text) => prompt(h, session, terminal, text).pipe(Effect.provideContext(platform)),
    })

    return Sessions.of({
      spawn,
      send,
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
          locks: locks.size(),
          reconciles: yield* reconcile.reconciles,
        }
      }),
      outdated,
      restart,
      restartLater,
    })
  })

  static readonly layer = Layer.effect(Sessions, Sessions.make)

  static readonly deps = SESSION_DEPS

  static readonly node = LayerNode.make({ service: Sessions, layer: Sessions.layer, deps: SESSION_DEPS })
}
