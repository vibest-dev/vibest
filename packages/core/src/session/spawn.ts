import { newId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import {
  AllocationFailed,
  describeSpawn,
  LimitReached,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  runnableNote,
  type RuntimeMachine,
  HarnessUnavailable,
  type HarnessId,
} from "@vibest/schema/session"
import { Clock, Config, Context, Crypto, Deferred, Effect, Exit, FileSystem, Layer, Option, Path, Ref } from "effect"
import { Hex } from "effect/encoding"

import { Agents, unknownAgent } from "../agents.ts"
import type { PeerStart } from "../database/db-remote.ts"
import { type NewSession, type SessionRow, harnessIdOf, runtimeOf, terminalOf, archived } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { Drain } from "../drain.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Git } from "../git.ts"
import { harnessCatalog, harnessOptions, Harness, preflight } from "../harness.ts"
import { Harnesses, unprovided } from "../harnesses.ts"
import { ALLOCATION_LEAF, ALLOCATION_NAME_ATTEMPTS, safeRepositoryDirectory } from "../paths.ts"
import { Plugins, pluginsNode, type Routing } from "../plugin.ts"
import { listProjectRepositories } from "../project/create.ts"
import * as Reactor from "../reactor.ts"
import { sessionEnvelope } from "../replies.ts"
import { machinesListing as machines, type Runtime, Runtimes } from "../runtimes.ts"
import { allocationParentBlocked, mainCheckout, repositoryDirectoryName } from "../worktree.ts"
import { Archive } from "./archive.ts"
import { directoryLock, SessionLocks } from "./locks.ts"
import { Move } from "./move.ts"
import { type LaunchOptions, Placement } from "./placement.ts"

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

const make = (options: { readonly maxSessions: number | undefined }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const runtimes = yield* Runtimes.Service
    const harness = yield* Harness.Service
    const harnesses = yield* Harnesses.Service
    const agents = yield* Agents.Service
    const plugins = yield* Plugins
    const drain = yield* Drain.Service
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const git = yield* Git.Service
    const scope = yield* Effect.scope
    const locks = yield* SessionLocks
    const { worktreeOf, launch, launchFailed } = yield* Placement
    const { abandonLaunch } = yield* Archive
    const { rerun } = yield* Move
    const logged = Reactor.logFailure
    const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Git.Service>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Git.Service, git),
      )
    const launchOwned = (
      h: Runtime,
      target: string | undefined,
      row: SessionRow,
      root: string,
      task: string,
      options: LaunchOptions,
    ) =>
      launch(h, target, row, root, task, options).pipe(
        Effect.flatMap((outcome) =>
          outcome._tag === "Limited"
            ? rerun(h, row, undefined, outcome.input, false, outcome.error, 0).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? launchFailed(row, exit.cause).pipe(
                        Effect.andThen(abandonLaunch(row.id)),
                        logged(`abandon ${row.id}`),
                      )
                    : Effect.void,
                ),
              )
            : Effect.void,
        ),
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

    const spawn = Effect.fn("Session.spawn")(function* (input: SpawnInput) {
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
          Effect.provideService(Harness.Service, harness),
          Effect.provideService(Harnesses.Service, harnesses),
        ),
        attempts: [],
        machine: { id: followedShare === undefined ? input.machine.id : terminalOf(followedShare).machine },
        runtime: followedShare === undefined ? input.runtime : runtimeOf(followedShare),
        parentRuntime,
        machines: yield* machinesListing,
      })
      const { provider, model } = decision
      const runnableHere = harnessCatalog.pipe(
        Effect.provideService(Harness.Service, harness),
        Effect.provideService(Harnesses.Service, harnesses),
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
        Effect.provideService(Harness.Service, harness),
        Effect.provideService(Harnesses.Service, harnesses),
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
      const held = yield* Deferred.make<void>()
      const reserveWorktree = (folders: boolean) =>
        Effect.gen(function* () {
          const refuse = (message: string) => new AllocationFailed({ message })
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
          for (let i = 0; i < ALLOCATION_NAME_ATTEMPTS; i++) {
            const candidate = Hex.encode(yield* crypto.randomBytes(2).pipe(Effect.orDie))
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
            if (made) return where
          }
          return yield* refuse(
            `no unused 4-hex worktree name under ${repository} after ${ALLOCATION_NAME_ATTEMPTS} attempts`,
          )
        })
      const admit = (shared: string | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handedOver = yield* Ref.make(false)
            const folders = yield* listProjectRepositories(root).pipe(
              Effect.mapError((e) => new AllocationFailed({ message: `${root}: ${e.message}` })),
            )
            const cwd =
              shared ??
              (yield* Effect.acquireRelease(reserveWorktree(folders !== undefined), (reserved) =>
                Ref.get(handedOver).pipe(
                  Effect.flatMap((owned) =>
                    owned ? Effect.void : fs.remove(reserved, { recursive: true }).pipe(Effect.ignore),
                  ),
                ),
              ))
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
            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const inserted = yield* db.insertSession(draft, input.projectId, {
                  max: options.maxSessions,
                  cwd,
                  task,
                  parentSessionId: input.parentSessionId,
                  request: input.request,
                  origin: input.origin,
                  archiveOnIdle: input.archive === true,
                })
                if (inserted === false) return yield* new LimitReached({ limit: options.maxSessions! })
                if (inserted === "parent-ended")
                  return yield* new NoSuchSession({
                    id: input.parentSessionId!,
                    message: `${input.parentSessionId} has ended and can no longer start sessions`,
                  })
                if (inserted !== true) return { before: inserted }
                yield* Ref.set(handedOver, true)
                const row = (yield* db.getSession(id))!
                const leave = drain.track(`spawn ${id}`)
                yield* Effect.forkIn(
                  locks
                    .withLock(id)(
                      Deferred.succeed(held, undefined).pipe(
                        Effect.andThen(
                          launchOwned(rt, target, row, root, task, {
                            splitFrom: input.share,
                            env: input.env,
                            commit: input.commit,
                          }),
                        ),
                      ),
                    )
                    .pipe(Effect.ensuring(leave), logged(`spawn ${id}`)),
                  scope,
                )
                return { before: undefined }
              }),
            )
          }),
        )
      const admitted =
        input.share === undefined
          ? yield* admit(undefined)
          : yield* locks.withLock(directoryLock((yield* db.sessionDirectory(input.share)) ?? ""))(
              Effect.gen(function* () {
                const shared = yield* shareOf(input, input.share!, runtimeKind, decision.machine.id)
                return yield* admit(shared)
              }),
            )
      if (admitted.before !== undefined) {
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
      yield* Deferred.await(held)
      return { id, harness: harnessId, provider, model, runtime: runtimeKind, ...routing }
    }, provided)

    return { spawn }
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
    Archive.node,
    Move.node,
    Placement.node,
    pluginsNode,
    Runtimes.node,
    SessionLocks.node,
    PlatformNode.crypto,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ] as const

  static readonly node = LayerNode.make({ service: Spawn, layer: Spawn.layer, deps: Spawn.deps })
}
