import { newId } from "@vibest/schema/id"
import { AllocationFailed, LimitReached, NoHarnessChosen, NoRuntime, NoSuchSession } from "@vibest/schema/session"
import { Clock, Context, Crypto, Deferred, Effect, FileSystem, Option, Path } from "effect"
import type { Scope } from "effect"
import { Hex } from "effect/encoding"

import type { Db, PeerStart, SessionRow } from "./db.ts"
import type { Drain } from "./drain.ts"
import {
  harnessOptions,
  Harness,
  Harnesses,
  HarnessUnavailable,
  type HarnessId,
  preflight,
  unprovided,
} from "./harness.ts"
import { directoryLock, type keyedLock } from "./keyed-lock.ts"
import { ALLOCATION_LEAF, ALLOCATION_NAME_ATTEMPTS, type Layout, safeRepositoryDirectory } from "./paths.ts"
import type { sessionPlacement } from "./placement.ts"
import { describeSpawn, type Plugins, type Routing } from "./plugins.ts"
import { listProjectRepositories } from "./project-create.ts"
import { type Machine, machinesListing as machines, type Runtimes } from "./runtimes.ts"
import type { Platform } from "./session-types.ts"
import { allocationParentBlocked, mainCheckout, repositoryDirectoryName } from "./worktree.ts"

export const peerAdmitPause: { wait: Effect.Effect<void> } = { wait: Effect.void }
export const allocationNameSource: { leaves: ReadonlyArray<string> | undefined } = { leaves: undefined }

export const defaultSessionName = (prompt: string) => (prompt.trim().split("\n")[0] ?? "").slice(0, 40) || "task"

export interface SpawnInput {
  readonly machine: Machine
  readonly root: string
  readonly projectId: string
  readonly name: string
  readonly prompt: string
  readonly harness?: HarnessId | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly agent?: string | undefined
  readonly peer?: string | undefined
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

export const sessionSpawn = (deps: {
  readonly db: Db["Service"]
  readonly runtimes: Runtimes["Service"]
  readonly harness: Harness["Service"]
  readonly harnesses: Harnesses["Service"]
  readonly plugins: Plugins["Service"]
  readonly drain: Drain["Service"]
  readonly layout: Layout["Service"]
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly crypto: Crypto.Crypto
  readonly platform: Context.Context<Platform>
  readonly scope: Scope.Scope
  readonly locks: ReturnType<typeof keyedLock<string>>
  readonly options: { readonly maxSessions: number | undefined }
  readonly worktreeOf: (session: SessionRow) => Effect.Effect<string, NoSuchSession>
  readonly logged: (what: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<void | A, never, R>
  readonly launch: ReturnType<typeof sessionPlacement>["launch"]
}) => {
  const {
    db,
    runtimes,
    harness,
    harnesses,
    plugins,
    drain,
    layout,
    fs,
    path,
    crypto,
    platform,
    scope,
    locks,
    worktreeOf,
    logged,
    launch,
    options,
  } = deps
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
      yield* runtimes.online(rt, { id: decision.machine.id })
      return rt
    })

  const peerOf = (input: SpawnInput, id: string, runtime: string, machineId: string) =>
    Effect.gen(function* () {
      const refuse = (why: string) => new NoSuchSession({ id, message: `--peer ${id}: ${why}` })
      const p = yield* db.getSession(id)
      if (!p) return yield* refuse(`no session ${id}`)
      if (p.projectId !== input.projectId) return yield* refuse("it belongs to another project")
      if (p.metadata.archived || p.metadata.removed) return yield* refuse("it was archived")
      if (p.runtime !== runtime || p.address.machine !== machineId)
        return yield* refuse(
          `ineligible: it runs in ${p.runtime} on ${p.address.machine}, not ${runtime} on ${machineId}`,
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
    const root = input.root
    const agent = input.agent ?? "general"
    const worker = input.parentSessionId === undefined ? undefined : yield* db.getSession(input.parentSessionId)
    const main =
      worker === undefined && input.parentSessionId !== undefined ? yield* db.coordinatorOf(input.projectId) : undefined
    const parentRuntime =
      worker !== undefined
        ? worker.runtime || undefined
        : main !== undefined && main.id === input.parentSessionId
          ? main.runtime || undefined
          : undefined
    const from =
      input.harness !== undefined
        ? undefined
        : (worker ??
          main ??
          (input.parentSessionId === undefined ? yield* db.coordinatorOf(input.projectId) : undefined))
    const namedPeer =
      input.runtime === undefined && input.peer !== undefined ? yield* db.getSession(input.peer) : undefined
    const followedPeer =
      namedPeer !== undefined &&
      namedPeer.projectId === input.projectId &&
      !namedPeer.metadata.archived &&
      !namedPeer.metadata.removed
        ? namedPeer
        : undefined
    const decision = yield* plugins.start({
      project: root,
      agentType: agent,
      parentSessionId: input.parentSessionId,
      prompt: input.prompt,
      harness: input.harness ?? from?.harnessId,
      provider: input.provider ?? from?.provider ?? undefined,
      model: input.model ?? from?.model ?? undefined,
      harnesses: yield* harnessOptions.pipe(
        Effect.provideService(Harness, harness),
        Effect.provideService(Harnesses, harnesses),
      ),
      attempts: [],
      machine: { id: followedPeer?.address.machine ?? input.machine.id },
      runtime: followedPeer?.runtime ?? input.runtime,
      parentRuntime,
      machines: yield* machinesListing,
    })
    const { provider, model } = decision
    if (decision.harness === undefined) return yield* new NoHarnessChosen()
    const rt = yield* chosenRuntime(decision)
    const machine: Machine = {
      id: decision.machine.id,
      ...(input.machine.id === decision.machine.id && input.machine.target !== undefined
        ? { target: input.machine.target }
        : {}),
    }
    const runtimeKind = rt.id
    const routed = (e: HarnessUnavailable) =>
      Object.keys(decision.decidedBy).length === 0
        ? e
        : new HarnessUnavailable({
            harness: e.harness,
            message: `${e.message} (routed: ${describeSpawn({ ...decision, harness: e.harness })})`,
          })
    const harnessId = decision.harness
    if (harnesses.find(harnessId) === undefined) return yield* routed(unprovided(harnessId, harnesses.all))
    yield* preflight(harnessId, provider ?? null, model ?? null).pipe(
      Effect.provideService(Harness, harness),
      Effect.provideService(Harnesses, harnesses),
      Effect.mapError(routed),
    )
    const adapter = yield* harnesses.get(harnessId)
    const routing: Routing = { decidedBy: decision.decidedBy, trace: decision.trace }
    const id = yield* db.newSessionId
    const now = yield* Clock.currentTimeMillis
    const admit = (shared: string | undefined) =>
      Effect.gen(function* () {
        const refuse = (message: string) => new AllocationFailed({ message })
        const folders = yield* listProjectRepositories(root).pipe(
          Effect.mapError((e) => refuse(`${root}: ${e.message}`)),
        )
        const base = {
          routing,
          ...(input.archive ? { archive: true } : {}),
        }
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
        const draft: Omit<SessionRow, "projectId"> = {
          id,
          agent,
          name: input.name,
          harnessId,
          provider: provider ?? null,
          model: model ?? null,
          harnessSessionId: adapter.ownSessionId ? yield* newId() : null,
          runtime: runtimeKind,
          address: { machine: machine.id, id: "" },
          status: "unknown",
          startedAt: null,
          exitedAt: null,
          turnState: "none",
          turnPromptedAt: 0,
          metadata: base,
          createdAt: now,
          lastActive: now,
        }
        const inserted = yield* db.insertSession(draft, input.projectId, {
          max: options.maxSessions,
          cwd,
          task: decision.prompt,
          parentSessionId: input.parentSessionId,
          request: input.request,
          origin: input.origin,
        })
        const unreserve = shared === undefined ? fs.remove(cwd, { recursive: true }).pipe(Effect.ignore) : Effect.void
        if (inserted === false) {
          yield* unreserve
          return yield* new LimitReached({ limit: options.maxSessions! })
        }
        if (inserted !== true) {
          yield* unreserve
          return { before: inserted }
        }
        return { row: (yield* db.getSession(id))! }
      })
    const admitted =
      input.peer === undefined
        ? yield* admit(undefined)
        : yield* locks.withLock(directoryLock((yield* db.sessionDirectory(input.peer)) ?? ""))(
            Effect.gen(function* () {
              const shared = yield* peerOf(input, input.peer!, runtimeKind, decision.machine.id)
              yield* peerAdmitPause.wait
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
                  launch(rt, machine, row, root, decision.prompt, {
                    splitFrom: input.peer,
                    env: input.env,
                    commit: input.commit,
                  }),
                ),
              ),
            )
            .pipe(Effect.ensuring(leave), logged(`spawn ${id}`), Effect.provideContext(platform)),
          scope,
        )
      }),
    )
    yield* Deferred.await(held)
    return { id, harness: harnessId, provider, model, runtime: runtimeKind, ...routing }
  }, Effect.provideContext(platform))

  return { spawn }
}
