import { newId } from "@vibest/schema/id"
import {
  AllocationFailed,
  LimitReached,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  runnableNote,
  type RuntimeMachine,
} from "@vibest/schema/session"
import { Clock, Config, Context, Crypto, Deferred, Effect, FileSystem, Layer, Option, Path } from "effect"
import type { Scope } from "effect"
import { Hex } from "effect/encoding"

import { Agents, unknownAgent } from "../agents.ts"
import {
  Db,
  type NewSession,
  type PeerStart,
  type SessionRow,
  harnessIdOf,
  runtimeOf,
  terminalOf,
  archived,
} from "../db.ts"
import { Drain } from "../drain.ts"
import { LayerNode } from "../effect/layer-node.ts"
import * as PlatformNode from "../effect/platform.ts"
import * as Engine from "../engine.ts"
import {
  harnessCatalog,
  harnessOptions,
  Harness,
  Harnesses,
  HarnessUnavailable,
  type HarnessId,
  preflight,
  unprovided,
} from "../harness.ts"
import { directoryLock, type keyedLock } from "../keyed-lock.ts"
import { ALLOCATION_LEAF, ALLOCATION_NAME_ATTEMPTS, Layout, safeRepositoryDirectory } from "../paths.ts"
import { describeSpawn, Plugins, type Routing } from "../plugins.ts"
import { listProjectRepositories } from "../project-create.ts"
import { sessionEnvelope } from "../replies.ts"
import { machinesListing as machines, Runtimes } from "../runtimes.ts"
import { allocationParentBlocked, Git, mainCheckout, repositoryDirectoryName } from "../worktree.ts"
import { SessionLocks } from "./locks.ts"
import { Move, type LimitMove } from "./move.ts"
import { Placement } from "./placement.ts"

export const shareAdmitPause: { wait: Effect.Effect<void> } = { wait: Effect.void }
export const allocationNameSource: { leaves: ReadonlyArray<string> | undefined } = { leaves: undefined }

export const defaultSessionName = (prompt: string) => (prompt.trim().split("\n")[0] ?? "").slice(0, 40) || "task"

export interface SpawnInput {
  readonly machine: RuntimeMachine
  readonly root: string
  readonly projectId: string
  readonly name: string
  readonly prompt: string
  readonly harness?: HarnessId | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly agent: string
  readonly share?: string | undefined
  readonly archive?: boolean | undefined
  readonly runtime?: string | undefined
  readonly parentSessionId?: string | undefined
  readonly request?: string | undefined
  readonly commit?: string | undefined
  readonly origin?: PeerStart | undefined
}

export interface Spawned extends Routing {
  readonly id: string
  readonly harness: HarnessId
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly runtime: string
}

const sessionSpawn = (deps: {
  readonly db: Db["Service"]
  readonly runtimes: Runtimes["Service"]
  readonly harness: Harness["Service"]
  readonly harnesses: Harnesses["Service"]
  readonly agents: Agents["Service"]
  readonly plugins: Plugins["Service"]
  readonly drain: Drain["Service"]
  readonly layout: Layout["Service"]
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly crypto: Crypto.Crypto
  readonly git: Git["Service"]
  readonly scope: Scope.Scope
  readonly locks: ReturnType<typeof keyedLock<string>>
  readonly options: { readonly maxSessions: number | undefined }
  readonly worktreeOf: (session: SessionRow) => Effect.Effect<string, NoSuchSession>
  readonly logged: (what: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<void | A, never, R>
  readonly launch: Placement["Service"]["launch"]
  readonly onOwnLimit: LimitMove["rerun"]
}) => {
  const {
    db,
    runtimes,
    harness,
    harnesses,
    agents,
    plugins,
    drain,
    layout,
    fs,
    path,
    crypto,
    git,
    scope,
    locks,
    worktreeOf,
    logged,
    launch,
    onOwnLimit,
    options,
  } = deps
  const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Git>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Git, git),
    )
  const machinesListing = machines(
    runtimes,
    harnesses.all.map((adapter) => adapter.id),
  )

  const chosenRuntime = (decision: {
    readonly machine: { readonly id: string }
    readonly runtime: string | undefined
  }) =>
    Effect.gen(function* () {
      if (decision.runtime === undefined) {
        const machines = yield* machinesListing
        const list = machines[0]!.runtimes
          .map((runtime) => `${runtime.kind}: ${runtime.status}${runtime.reason ? ` (${runtime.reason})` : ""}`)
          .join("; ")
        return yield* new NoRuntime({
          message: `no terminal runtime was chosen for this start (${list || "none is loaded"})`,
        })
      }
      const rt = yield* runtimes.route(decision.runtime)
      yield* runtimes.online(rt)
      return rt
    })

  const shareOf = (input: SpawnInput, id: string, runtime: string, machineId: string) =>
    Effect.gen(function* () {
      const refuse = (why: string) => new NoSuchSession({ id, message: `--share ${id}: ${why}` })
      const p = yield* db.getSession(id)
      if (!p) return yield* refuse(`no session ${id}`)
      if (p.projectId !== input.projectId) return yield* refuse("it belongs to another project")
      if (archived(p)) return yield* refuse("it was archived")
      if (runtimeOf(p) !== runtime || terminalOf(p).machine !== machineId)
        return yield* refuse(
          `ineligible: it runs in ${runtimeOf(p)} on ${terminalOf(p).machine}, not ${runtime} on ${machineId}`,
        )
      const worktree = yield* worktreeOf(p).pipe(Effect.mapError((e) => refuse(e.message)))
      if (!(yield* fs.exists(worktree).pipe(Effect.orDie)))
        return yield* refuse(`ineligible: its worktree ${worktree} is gone`)
      if (
        !(yield* listProjectRepositories(worktree).pipe(Effect.mapError((e) => refuse(e.message)))) &&
        !Option.contains(yield* mainCheckout(worktree).pipe(Effect.option), input.root)
      )
        return yield* refuse(`ineligible: its worktree is not in ${input.root}`)
      return worktree
    })

  const spawn = Effect.fn("Sessions.spawn")(function* (input: SpawnInput) {
    if (input.parentSessionId === undefined && input.origin?.reportTo === undefined)
      return yield* new NoCallingSession()
    const root = input.root
    const agent = input.agent
    if (agents.find(agent) === undefined) return yield* unknownAgent(agent, agents.all)
    const parent = input.parentSessionId === undefined ? undefined : yield* db.getSession(input.parentSessionId)
    const parentRuntime = parent === undefined ? undefined : runtimeOf(parent) || undefined
    const from = input.harness !== undefined ? undefined : parent
    const namedShare =
      input.runtime === undefined && input.share !== undefined ? yield* db.getSession(input.share) : undefined
    const followedShare =
      namedShare !== undefined && namedShare.projectId === input.projectId && !archived(namedShare)
        ? namedShare
        : undefined
    const decision = yield* plugins.start({
      project: root,
      agent,
      parentSessionId: input.parentSessionId,
      prompt: input.prompt,
      harness: input.harness ?? (from === undefined ? undefined : harnessIdOf(from)),
      provider: input.provider ?? from?.process?.provider ?? undefined,
      model: input.model ?? from?.process?.model ?? undefined,
      harnesses: yield* harnessOptions.pipe(
        Effect.provideService(Harness, harness),
        Effect.provideService(Harnesses, harnesses),
      ),
      attempts: [],
      machine: { id: followedShare === undefined ? input.machine.id : terminalOf(followedShare).machine },
      runtime: followedShare === undefined ? input.runtime : runtimeOf(followedShare),
      parentRuntime,
      machines: yield* machinesListing,
    })
    const { provider, model } = decision
    const runnableHere = harnessCatalog.pipe(
      Effect.provideService(Harness, harness),
      Effect.provideService(Harnesses, harnesses),
      Effect.map((choices) => choices.filter((choice) => choice.problem === null).map((choice) => choice.harness)),
    )
    if (decision.harness === undefined) return yield* new NoHarnessChosen({ runnable: yield* runnableHere })
    const rt = yield* chosenRuntime(decision)
    const target = input.machine.id === decision.machine.id ? input.machine.target : undefined
    const runtimeKind = rt.id
    const inheritedFrom =
      from !== undefined && Object.keys(decision.decidedBy).length === 0 && decision.harness === harnessIdOf(from)
        ? from.id
        : undefined
    const routed = (e: HarnessUnavailable) =>
      Effect.gen(function* () {
        const origin =
          Object.keys(decision.decidedBy).length > 0
            ? ` (routed: ${describeSpawn({ ...decision, harness: e.harness })})`
            : inheritedFrom === undefined
              ? ""
              : ` (inherited from ${inheritedFrom})`
        return yield* new HarnessUnavailable({
          harness: e.harness,
          message: `${e.message}${origin}${runnableNote(yield* runnableHere)}`,
        })
      })
    const harnessId = decision.harness
    if (harnesses.find(harnessId) === undefined) return yield* routed(unprovided(harnessId, harnesses.all))
    yield* preflight(harnessId, provider ?? null, model ?? null, input.env).pipe(
      Effect.provideService(Harness, harness),
      Effect.provideService(Harnesses, harnesses),
      Effect.catchTag("HarnessUnavailable", routed),
    )
    const adapter = yield* harnesses.get(harnessId)
    const sender =
      parent !== undefined
        ? { id: parent.id, title: parent.name }
        : input.origin?.reportTo === undefined
          ? undefined
          : { id: input.origin.reportTo }
    const task = sender === undefined ? decision.prompt : sessionEnvelope(sender, decision.prompt)
    const routing: Routing = { decidedBy: decision.decidedBy, trace: decision.trace }
    const id = yield* db.newSessionId
    const now = yield* Clock.currentTimeMillis
    const admit = (shared: string | undefined) =>
      Effect.gen(function* () {
        const refuse = (message: string) => new AllocationFailed({ message })
        const folders = yield* listProjectRepositories(root).pipe(
          Effect.mapError((e) => refuse(`${root}: ${e.message}`)),
        )
        let cwd = shared
        if (cwd === undefined) {
          const repository = folders
            ? path.basename(root)
            : yield* repositoryDirectoryName(root).pipe(Effect.mapError((e) => refuse(e.message)))
          if (!safeRepositoryDirectory(repository))
            return yield* refuse(
              `repository name ${JSON.stringify(repository)} cannot be a directory under worktrees (empty, unsafe, or a session id)`,
            )
          const parentPath = path.join(layout.worktrees, repository)
          if (
            yield* allocationParentBlocked(parentPath).pipe(
              Effect.mapError((e) => refuse(`${parentPath}: ${e.message}`)),
            )
          )
            return yield* refuse(
              `refusing to allocate inside ${parentPath}: it is an existing worktree or not a directory`,
            )
          yield* fs.makeDirectory(parentPath, { recursive: true }).pipe(Effect.mapError((e) => refuse(e.message)))
          const scripted = allocationNameSource.leaves
          const attempts =
            scripted === undefined ? ALLOCATION_NAME_ATTEMPTS : Math.min(scripted.length, ALLOCATION_NAME_ATTEMPTS)
          for (let i = 0; i < attempts && cwd === undefined; i++) {
            const candidate = scripted?.[i] ?? Hex.encode(yield* crypto.randomBytes(2).pipe(Effect.orDie))
            if (!ALLOCATION_LEAF.test(candidate)) continue
            const where = layout.allocationWorktree(repository, candidate)
            const made = yield* fs.makeDirectory(where).pipe(
              Effect.as(true),
              Effect.catchTag("PlatformError", (e) =>
                e.reason._tag === "AlreadyExists"
                  ? Effect.succeed(false)
                  : Effect.fail(refuse(`${where}: ${e.message}`)),
              ),
            )
            if (made) cwd = where
          }
          if (cwd === undefined)
            return yield* refuse(`no unused 4-hex worktree name under ${repository} after ${attempts} attempts`)
        }
        const draft: Omit<NewSession, "projectId"> = {
          id,
          agent,
          name: input.name,
          harnessId,
          provider: provider ?? null,
          model: model ?? null,
          harnessSessionId: adapter.ownSessionId ? yield* newId() : null,
          runtime: runtimeKind,
          address: { machine: decision.machine.id, id: "" },
          status: "unknown",
          startedAt: null,
          exitedAt: null,
          executionState: "none",
          executionPromptedAt: 0,
          ...(routing === undefined ? {} : { routing }),
          createdAt: now,
          lastActive: now,
        }
        const inserted = yield* db.insertSession(draft, input.projectId, {
          max: options.maxSessions,
          cwd,
          task,
          parentSessionId: input.parentSessionId,
          request: input.request,
          origin: input.origin,
          archiveOnIdle: input.archive === true,
        })
        const unreserve = shared === undefined ? fs.remove(cwd, { recursive: true }).pipe(Effect.ignore) : Effect.void
        if (inserted === false) {
          yield* unreserve
          return yield* new LimitReached({ limit: options.maxSessions! })
        }
        if (inserted === "parent-ended") {
          yield* unreserve
          return yield* new NoSuchSession({
            id: input.parentSessionId!,
            message: `${input.parentSessionId} has ended and can no longer start sessions`,
          })
        }
        if (inserted !== true) {
          yield* unreserve
          return { before: inserted }
        }
        return { row: (yield* db.getSession(id))! }
      })
    const admitted =
      input.share === undefined
        ? yield* admit(undefined)
        : yield* locks.withLock(directoryLock((yield* db.sessionDirectory(input.share)) ?? ""))(
            Effect.gen(function* () {
              const shared = yield* shareOf(input, input.share!, runtimeKind, decision.machine.id)
              yield* shareAdmitPause.wait
              return yield* admit(shared)
            }),
          )
    if ("before" in admitted) {
      const { before } = admitted
      return {
        id: before.id,
        harness: before.harness as HarnessId,
        provider: before.provider,
        model: before.model,
        runtime: before.runtime,
        decidedBy: before.routing?.decidedBy ?? {},
        trace: before.routing?.trace ?? [],
      }
    }
    const row = admitted.row
    const held = yield* Deferred.make<void>()
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const leave = drain.track(`spawn ${id}`)
        yield* Effect.forkIn(
          locks
            .withLock(id)(
              Deferred.succeed(held, undefined).pipe(
                Effect.andThen(
                  launch(rt, target, row, root, task, {
                    splitFrom: input.share,
                    env: input.env,
                    commit: input.commit,
                    onOwnLimit,
                  }),
                ),
              ),
            )
            .pipe(Effect.ensuring(leave), logged(`spawn ${id}`)),
          scope,
        )
      }),
    )
    yield* Deferred.await(held)
    return { id, harness: harnessId, provider, model, runtime: runtimeKind, ...routing }
  }, provided)

  return { spawn }
}

const make = (options: { readonly maxSessions: number | undefined }) =>
  Effect.gen(function* () {
    const { worktreeOf, launch } = yield* Placement
    return sessionSpawn({
      db: yield* Db,
      runtimes: yield* Runtimes,
      harness: yield* Harness,
      harnesses: yield* Harnesses,
      agents: yield* Agents,
      plugins: yield* Plugins,
      drain: yield* Drain,
      layout: yield* Layout,
      fs: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      git: yield* Git,
      scope: yield* Effect.scope,
      locks: yield* SessionLocks,
      options,
      worktreeOf,
      logged: Engine.logFailure,
      launch,
      onOwnLimit: (yield* Move).rerun,
    })
  })

export class Spawn extends Context.Service<Spawn, Effect.Success<ReturnType<typeof make>>>()("vibest/Spawn") {
  static readonly make = make

  static readonly layer = Layer.effect(
    Spawn,
    Config.option(Config.Int("VIBEST_MAX_SESSIONS")).pipe(
      Effect.flatMap((max) => make({ maxSessions: Option.getOrUndefined(max) })),
    ),
  )

  static readonly configured = (options: { readonly maxSessions: number | undefined }) =>
    LayerNode.make({ service: Spawn, layer: Layer.effect(Spawn, make(options)), deps: Spawn.deps })

  static readonly deps = [
    Agents.node,
    Db.node,
    Drain.node,
    Git.node,
    Harness.node,
    Harnesses.node,
    Move.node,
    Placement.node,
    Plugins.node,
    Runtimes.node,
    SessionLocks.node,
    PlatformNode.crypto,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ] as const

  static readonly node = LayerNode.make({ service: Spawn, layer: Spawn.layer, deps: Spawn.deps })
}
