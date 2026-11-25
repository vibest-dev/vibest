import { newId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import {
  AllocationFailed,
  describeSpawn,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  runnableNote,
  type RuntimeMachine,
  HarnessUnavailable,
  type HarnessId,
} from "@vibest/schema/session"
import { LayerNode } from "@vibest/util/layer-node"
import { Clock, Context, Deferred, Effect, FileSystem, Layer, Option, Path, Predicate, Ref, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Hex } from "effect/encoding"

import { definitionLaunch } from "../agent/launch.ts"
import { Agents, unknownAgent } from "../agent/registry.ts"
import {
  type NewSession,
  type ProcessStart,
  type SessionRow,
  harnessIdOf,
  runtimeOf,
  archived,
} from "../database/rows.ts"
import { PlatformNode } from "../effect/platform.ts"
import { harnessCatalog, harnessOptions, Harness, preflight } from "../harness.ts"
import { Harnesses, unprovided } from "../harness/registry.ts"
import { ALLOCATION_LEAF, ALLOCATION_NAME_ATTEMPTS, safeRepositoryDirectory } from "../paths.ts"
import { Plugins, type Routing } from "../plugin.ts"
import { listProjectRepositories, type PinnedFolder } from "../project/create.ts"
import * as Reactor from "../reactor.ts"
import type { RemoteStart } from "../remote/sql.ts"
import { Drain } from "../runtime/drain.ts"
import { machinesListing as machines, Runtimes } from "../runtime/registry.ts"
import { allocationParentBlocked, mainCheckout, repositoryDirectoryName } from "../worktree.ts"
import { Git } from "../worktree/git.ts"
import { directoryLock, SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"
import { sessionEnvelope } from "./replies.ts"
import { Starts } from "./starts.ts"
import { SessionStore } from "./store.ts"

export * as Spawn from "./spawn.ts"

export class LinkRefused extends Schema.TaggedError<LinkRefused>()("LinkRefused", { message: Schema.String }) {}

export const defaultSessionName = (prompt: string) => (prompt.trim().split("\n")[0] ?? "").slice(0, 40) || "task"

export interface Attachment {
  readonly name: string
  readonly content: Uint8Array
}

const UNNAMED = new Set(["", ".", ".."])

export const attachmentNames = (names: ReadonlyArray<string>) => {
  const taken = new Set<string>()

  return names.map((given) => {
    const name = UNNAMED.has(given) ? "file" : given
    const dot = name.lastIndexOf(".")
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ""
    let unique = name

    for (let n = 2; taken.has(unique); n++) unique = `${stem}-${n}${extension}`
    taken.add(unique)

    return unique
  })
}

export const withAttachedFiles = (prompt: string, paths: ReadonlyArray<string>) =>
  paths.length === 0 ? prompt : `${prompt}${prompt.endsWith("\n") ? "\n" : "\n\n"}Attached files: ${paths.join(", ")}`

export const resolveLiveTarget = (sessionStore: SessionStore.Interface, projectId: string) => (ref: string) =>
  Effect.gen(function* () {
    const id = yield* sessionStore.resolveSession(ref)
    const row = yield* sessionStore.getSession(id)

    if (row === undefined) return yield* new NoSuchSession({ id, message: `no session ${id}` })

    if (row.projectId !== projectId) return yield* new LinkRefused({ message: `${id} belongs to another project` })

    if (archived(row)) return yield* new NoSuchSession({ id, message: `${id} was archived` })

    return id
  })

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
  readonly runtime?: string | undefined
  readonly parentSessionId?: string | undefined
  readonly request?: string | undefined
  readonly commit?: string | undefined
  readonly folders?: ReadonlyArray<PinnedFolder> | undefined
  readonly origin?: RemoteStart | undefined
  readonly files?: ReadonlyArray<Attachment> | undefined
  readonly from?: ReadonlyArray<string> | undefined
  readonly to?: ReadonlyArray<string> | undefined
  readonly with?: ReadonlyArray<string> | undefined
}

export interface Spawned extends Routing {
  readonly id: string
  readonly harness: HarnessId
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly runtime: string
}

export const make = Effect.gen(function* () {
  const sessionStore = yield* SessionStore.Service
  const runtimes = yield* Runtimes.Service
  const harness = yield* Harness.Service
  const harnesses = yield* Harnesses.Service
  const agents = yield* Agents.Service
  const plugins = yield* Plugins.Service
  const drain = yield* Drain.Service
  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const secureRandom = yield* SecureRandom.SecureRandom
  const git = yield* Git.Service
  const scope = yield* Effect.scope
  const locks = yield* SessionLocks.Service
  const { worktreeOf, launch } = yield* Placement.Service
  const starts = yield* Starts.Service
  const logged = Reactor.logFailure

  const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Git.Service>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Git.Service, git),
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

  const shareOf = (input: SpawnInput, id: string, runtime: string) =>
    Effect.gen(function* () {
      const refuse = (why: string) => new NoSuchSession({ id, message: `--share ${id}: ${why}` })
      const p = yield* sessionStore.getSession(id)

      if (!p) return yield* refuse(`no session ${id}`)

      if (p.projectId !== input.projectId) return yield* refuse("it belongs to another project")

      if (archived(p)) return yield* refuse("it was archived")

      if (runtimeOf(p) !== runtime) return yield* refuse(`ineligible: it runs in ${runtimeOf(p)}, not ${runtime}`)
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

  const spawn = Effect.fn("Session.spawn")(
    function* (input: SpawnInput) {
      if (input.parentSessionId === undefined && input.origin?.reportTo === undefined)
        return yield* new NoCallingSession()
      const root = input.root
      const agent = input.agent
      const definition = agents.find(agent)

      if (definition === undefined) return yield* unknownAgent(agent, agents)
      const ownLaunch = definitionLaunch(definition, input)

      const parent =
        input.parentSessionId === undefined ? undefined : yield* sessionStore.getSession(input.parentSessionId)

      const parentRuntime = parent === undefined ? undefined : runtimeOf(parent) || undefined
      const from = input.harness !== undefined || ownLaunch !== undefined ? undefined : parent

      const namedShare =
        input.runtime === undefined && input.share !== undefined
          ? yield* sessionStore.getSession(input.share)
          : undefined

      const followedShare =
        namedShare !== undefined && namedShare.projectId === input.projectId && !archived(namedShare)
          ? namedShare
          : undefined

      const resolveLink = resolveLiveTarget(sessionStore, input.projectId)

      const fromLinks = yield* Effect.forEach(input.from ?? [], resolveLink)
      const toLinks = yield* Effect.forEach(input.to ?? [], resolveLink)
      const withLinks = yield* Effect.forEach(input.with ?? [], resolveLink)

      const id = yield* sessionStore.newSessionId
      const attachments = input.files ?? []
      const sessionFolder = layout.sessionFolder(input.projectId, id)
      const filesFolder = path.join(sessionFolder, "files")

      const files = attachmentNames(attachments.map((file) => path.basename(file.name))).map((name) =>
        path.join(filesFolder, name),
      )

      const dropAttachments =
        attachments.length === 0
          ? Effect.void
          : fs.remove(sessionFolder, { recursive: true, force: true }).pipe(Effect.ignore)

      const writeAttachments =
        attachments.length === 0
          ? Effect.void
          : fs.makeDirectory(filesFolder, { recursive: true }).pipe(
              Effect.andThen(
                Effect.forEach(attachments, (file, i) => fs.writeFile(files[i]!, file.content), { discard: true }),
              ),
              Effect.onError(() => dropAttachments),
              Effect.mapError(
                (e) =>
                  new AllocationFailed({
                    message: `cannot copy the attached files into ${filesFolder}: ${e.message}`,
                  }),
              ),
            )

      const attachmentsOwned = yield* Ref.make(false)
      yield* Effect.acquireRelease(writeAttachments, () =>
        Ref.get(attachmentsOwned).pipe(Effect.flatMap((owned) => (owned ? Effect.void : dropAttachments))),
      )

      const decision = yield* plugins.start(
        {
          project: root,
          agent,
          parentSessionId: input.parentSessionId,
          prompt: withAttachedFiles(input.prompt, files),
          files,
          harness: ownLaunch?.choice.harness ?? input.harness ?? (from === undefined ? undefined : harnessIdOf(from)),
          provider: ownLaunch?.choice.provider ?? input.provider ?? from?.process?.provider ?? undefined,
          model: ownLaunch?.choice.model ?? input.model ?? from?.process?.model ?? undefined,
          harnesses: yield* harnessOptions.pipe(
            Effect.provideService(Harness.Service, harness),
            Effect.provideService(Harnesses.Service, harnesses),
          ),
          machine: { id: input.machine.id },
          runtime: followedShare === undefined ? input.runtime : runtimeOf(followedShare),
          parentRuntime,
          machines: yield* machinesListing,
        },
        ownLaunch?.decidedBy,
      )

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

      const senderId = parent?.id ?? input.origin?.reportTo

      const task = senderId === undefined ? decision.prompt : sessionEnvelope(senderId, decision.prompt)
      const routing: Routing = { decidedBy: decision.decidedBy, trace: decision.trace }
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
            const candidate = Hex.encode(yield* secureRandom.randomBytes(2))

            if (!ALLOCATION_LEAF.test(candidate)) continue
            const where = layout.allocationWorktree(repository, candidate)

            const made = yield* fs.makeDirectory(where).pipe(
              Effect.as(true),
              Effect.catchTag("PlatformError", (e) =>
                Predicate.isTagged(e.reason, "AlreadyExists")
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
              terminal: null,
              status: "unknown",
              startedAt: null,
              exitedAt: null,
              executionState: "none",
              executionPromptedAt: 0,
              ...(routing !== undefined && { routing }),
              createdAt: now,
              lastActive: now,
            }

            const chosen: ProcessStart = {
              harness: harnessId,
              ...(provider !== undefined && { provider }),
              ...(model !== undefined && { model }),
              routing,
              runtime: runtimeKind,
              ...(draft.harnessSessionId !== null && { resume: draft.harnessSessionId }),
            }

            const started = (go: (row: SessionRow) => Effect.Effect<void, unknown>, onLock: Effect.Effect<void>) =>
              Effect.suspend(() => {
                const leave = drain.track(`spawn ${id}`)

                return locks
                  .withLock(id)(
                    onLock.pipe(
                      Effect.andThen(sessionStore.getSession(id)),
                      Effect.flatMap((row) => (row === undefined ? Effect.void : go(row))),
                    ),
                  )
                  .pipe(Effect.ensuring(leave), logged(`spawn ${id}`))
              })

            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const launchAgent = (row: SessionRow) =>
                  launch(rt, target, row, root, task, {
                    splitFrom: input.share,
                    env: input.env,
                    commit: input.commit,
                    folders: input.folders,
                  })

                const inserted = yield* sessionStore.insertSession(draft, input.projectId, {
                  max: yield* starts.maxForNew,
                  cwd,
                  task,
                  parentSessionId: input.parentSessionId,
                  request: input.request,
                  origin: input.origin,
                  links: { from: fromLinks, to: toLinks, with: withLinks },
                })

                if (inserted === "parent-ended")
                  return yield* new NoSuchSession({
                    id: input.parentSessionId!,
                    message: `${input.parentSessionId} has ended and can no longer start sessions`,
                  })

                if (inserted === "waiting") {
                  yield* Ref.set(handedOver, true)
                  yield* Ref.set(attachmentsOwned, true)
                  yield* starts.wait({ id, start: chosen, launch: started(launchAgent, Effect.void) })

                  return { before: undefined, waiting: true }
                }

                if (inserted !== true) return { before: inserted }
                yield* Ref.set(handedOver, true)
                yield* Ref.set(attachmentsOwned, true)
                yield* Effect.forkIn(started(launchAgent, Deferred.succeed(held, undefined)), scope)

                return { before: undefined }
              }),
            )
          }),
        )

      const admitted =
        input.share === undefined
          ? yield* admit(undefined)
          : yield* locks.withLock(directoryLock((yield* sessionStore.sessionDirectory(input.share)) ?? ""))(
              Effect.gen(function* () {
                const shared = yield* shareOf(input, input.share!, runtimeKind)

                return yield* admit(shared)
              }),
            )

      if ("waiting" in admitted) return { id, harness: harnessId, provider, model, runtime: runtimeKind, ...routing }

      if (admitted.before !== undefined) {
        const { before } = admitted

        return {
          id: before.id,
          harness: before.harness || harnessId,
          provider: before.harness === "" ? provider : before.provider,
          model: before.harness === "" ? model : before.model,
          runtime: before.runtime || runtimeKind,
          decidedBy: before.routing?.decidedBy ?? {},
          trace: before.routing?.trace ?? [],
        }
      }

      yield* Deferred.await(held)

      return { id, harness: harnessId, provider, model, runtime: runtimeKind, ...routing }
    },
    Effect.scoped,
    provided,
  )

  return { spawn }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Spawn") {}

export const layer = Layer.effect(Service, make)

export const deps = [
  Agents.node,
  SessionStore.node,
  Drain.node,
  Git.node,
  Harness.node,
  Harnesses.node,
  Placement.node,
  Plugins.node,
  Runtimes.node,
  SessionLocks.node,
  Starts.node,
  PlatformNode.secureRandom,
  PlatformNode.fileSystem,
  PlatformNode.layout,
  PlatformNode.path,
] as const

export const node = LayerNode.make({ service: Service, layer, deps })
