import { Harness as PluginHarness } from "@vibest/plugin/effect"
import { messageOf } from "@vibest/schema/error"
import { sessionLabel } from "@vibest/schema/id"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { NoSuchSession } from "@vibest/schema/session"
import { LayerNode } from "@vibest/util/layer-node"
import { Cause, Clock, Context, Effect, Exit, FileSystem, Layer, Path, Ref } from "effect"
import { ChildProcessSpawner } from "effect/process"

import { definitionIn, withExecution, withProcess, type Launch } from "../agent/launch.ts"
import { Agents } from "../agent/registry.ts"
import {
  type SessionRow,
  harnessIdOf,
  runtimeOf,
  startOf,
  terminalOf,
  exitedAt,
  archived,
  limitFailure,
  limitText,
  type ExecutionFailure,
  type LimitAbout,
} from "../database/rows.ts"
import { PlatformNode } from "../effect/platform.ts"
import { cliEnv, Harness } from "../harness.ts"
import { Harnesses } from "../harness/registry.ts"
import { limitSeen, Subscriptions } from "../harness/subscriptions.ts"
import { Inbox } from "../inbox.ts"
import { InboxStore } from "../inbox/store.ts"
import {
  createIsolatedWorktrees,
  discardIsolatedWorktrees,
  listProjectRepositories,
  type PinnedFolder,
  projectRoot,
} from "../project/create.ts"
import { ProjectStore } from "../project/store.ts"
import { Runtimes, type Runtime, type Terminal } from "../runtime/registry.ts"
import { addWorktree, copyIncluded, mainCheckout, removeWorktree, repositoryDirectoryName } from "../worktree.ts"
import { Git } from "../worktree/git.ts"
import { Executions, notStartedMessage, Pickup } from "./executions.ts"
import { SessionLocks, terminalLock } from "./locks.ts"
import { isUsageLimitError } from "./replies.ts"
import { SessionStore } from "./store.ts"
import {
  configuredMcpServers,
  projectText,
  removeSystemPrompt,
  systemPrompt,
  withTask,
  writeSystemPrompt,
} from "./system-prompt.ts"

export * as Placement from "./placement.ts"

export const runtimeEnv = (runtime: string, target?: Terminal) =>
  JSON.stringify({ runtime, ...(target !== undefined && { target }) })

export interface FirstInput {
  readonly text: string
  readonly onHandover: Effect.Effect<void>
}

export type LaunchOptions = {
  readonly splitFrom?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly commit?: string | undefined
  readonly folders?: ReadonlyArray<PinnedFolder> | undefined
}

export const make = Effect.gen(function* () {
  const projectStore = yield* ProjectStore.Service
  const sessionStore = yield* SessionStore.Service
  const inboxStore = yield* InboxStore.Service
  const subscriptions = yield* Subscriptions.Service
  const runtimes = yield* Runtimes.Service
  const harness = yield* Harness.Service
  const harnesses = yield* Harnesses.Service
  const agents = yield* Agents.Service
  const inbox = yield* Inbox.Service
  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const git = yield* Git.Service
  const vibest = yield* VibestCommand
  const { openFirst, launched } = yield* Executions.Service
  const locks = yield* SessionLocks.Service

  const provided = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Git.Service
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Git.Service, git),
    )

  const notice = Effect.fn("Placement.notice")((session: SessionRow, message: string) =>
    inbox.enqueue({ sessionId: session.id, message }),
  )

  const worktreeOf = Effect.fn("Placement.worktreeOf")((session: SessionRow) =>
    sessionStore.sessionDirectory(session.id).pipe(
      Effect.flatMap((directory) =>
        directory
          ? Effect.succeed(directory)
          : Effect.fail(
              new NoSuchSession({
                id: session.id,
                message: `${session.id} records no directory; nothing was deleted`,
              }),
            ),
      ),
    ),
  )

  const vibestEnv = (session: SessionRow, process?: number) => ({
    ...(process !== undefined && { VIBEST_PROCESS: String(process) }),
    VIBEST_SESSION_ID: session.id,
    VIBEST_PROJECT_ID: session.projectId,
    VIBEST_PROJECT_DIR: layout.project(session.projectId),
    VIBEST_SCRATCHPAD_DIR: layout.scratchpadDir(session.projectId),
    VIBEST_HARNESS: harnessIdOf(session),
    VIBEST_RUNTIME: runtimeEnv(runtimeOf(session)),
    VIBEST_HOME: layout.home,
  })

  const systemPromptOf = Effect.fn("Placement.systemPromptOf")(function* (session: SessionRow) {
    const creator = yield* sessionStore.creatorLabel(session.id)
    const directory = yield* sessionStore.sessionDirectory(session.id)
    const projectDirectory = yield* projectStore.projectDirectory(session.projectId)

    const checkout =
      directory !== undefined &&
      directory !== "" &&
      projectDirectory !== undefined &&
      directory === projectDirectory &&
      !directory.startsWith(`${layout.worktrees}/`)

    const creatorLinked =
      creator !== undefined && (yield* inboxStore.maySend(session.id, creator.id, creator.remote ?? ""))

    const definition = yield* definitionIn(agents, session.agent)

    return systemPrompt({
      system: definition.system,
      id: session.id,
      checkout,
      sharer: yield* sessionStore.earlierSharer(session.id),
      creator: creator === undefined ? undefined : { id: creator.id, label: creator.label, linked: creatorLinked },
      linkedTo: yield* sessionStore.linkedTargets(session.id, creator?.id),
      projectDir: layout.project(session.projectId),
      scratchpadDir: layout.scratchpadDir(session.projectId),
      agents: agents.all,
      mcpServers: yield* configuredMcpServers(
        layout.home,
        directory || projectDirectory || undefined,
        definition.mcpServers,
      ),
      ...(yield* projectText(layout.project(session.projectId))),
    })
  }, provided)

  const launchOf = Effect.fn("Placement.launchOf")(function* (session: SessionRow, resume: boolean, first?: string) {
    const system = yield* systemPromptOf(session)
    const adapter = yield* harnesses.get(harnessIdOf(session))
    const pluginDir = yield* harness.plugin(adapter.id)
    const id = session.process?.harnessSessionId ?? null
    const resumeThis = resume && id !== null && (yield* sessionStore.canResumeConversation(session.id, id))
    const env = { ...vibestEnv(session), ...(yield* cliEnv(vibest, adapter.id)) }

    const worktree = yield* worktreeOf(session).pipe(
      Effect.catchTag("NoSuchSession", (error) =>
        projectStore
          .projectDirectory(session.projectId)
          .pipe(Effect.flatMap((dir) => (dir ? Effect.succeed(dir) : Effect.fail(error)))),
      ),
    )

    const scratchpadDir = layout.scratchpadDir(session.projectId)
    yield* fs.makeDirectory(layout.scratchRoot, { recursive: true, mode: 0o700 }).pipe(Effect.ignore)
    yield* fs.makeDirectory(scratchpadDir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore)

    return {
      harness: adapter.id,
      argv: PluginHarness.harnessArgv(
        adapter,
        {
          worktree,
          projectDir: layout.project(session.projectId),
          scratchpadDir,
          systemPromptFile: yield* writeSystemPrompt(session.id, system),
          provider: session.process?.provider ?? null,
          model: session.process?.model ?? null,
          sessionId: id,
          resume: resumeThis,
          pluginDir,
          vibest,
          env,
        },
        first,
      ),
      ...(first !== undefined && { prompt: first }),
      system,
      env,
    } satisfies Launch
  }, provided)

  const firstText = Effect.fn("Placement.firstText")(function* (session: SessionRow, task: string) {
    return (yield* harnesses.get(harnessIdOf(session))).systemPromptInPrompt
      ? withTask(yield* systemPromptOf(session), task)
      : task
  }, provided)

  const taskInput = (session: SessionRow, task: string) =>
    Effect.map(firstText(session, task), (text): FirstInput => ({ text, onHandover: inboxStore.linkTask(session.id) }))

  const limitOf = (
    session: SessionRow,
    error: string,
  ): Effect.Effect<{ readonly failure: ExecutionFailure; readonly about: LimitAbout } | undefined> =>
    Effect.gen(function* () {
      if (!isUsageLimitError(error)) return undefined
      const now = yield* Clock.currentTimeMillis
      const seen = limitSeen(yield* subscriptions.list, harnessIdOf(session), session.process?.provider ?? "", now)

      return { failure: limitFailure(error, seen.resetAt), about: seen }
    })

  const launching = Effect.fn("Placement.launching")(function* (
    session: SessionRow,
    resume: boolean,
    first?: FirstInput,
  ) {
    const base = yield* launchOf(session, resume, first?.text)
    const execution = yield* Ref.make<number | undefined>(undefined)
    let openedId: number | undefined
    const launch = (process: number | undefined) => withExecution(withProcess(base, process), openedId)

    const beforeStart =
      first === undefined
        ? Effect.void
        : Effect.flatMap(openFirst(session.id, first.onHandover), (opened) =>
            Effect.sync(() => {
              openedId = opened
            }).pipe(Effect.andThen(Ref.set(execution, opened))),
          )

    const deliver = (h: Runtime, row: SessionRow, terminal: Terminal) =>
      Effect.flatMap(Ref.get(execution), (opened) =>
        opened === undefined ? Effect.succeed(Pickup.Taken()) : launched(h, row, terminal, opened),
      )

    const abandoned = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const opened = yield* Ref.get(execution)

        if (opened === undefined) return
        const failure = (yield* limitOf(session, messageOf(Cause.squash(cause))))?.failure
        yield* sessionStore.closeExecution(session.id, opened, failure === undefined ? "not_started" : "failed", {
          failure,
        })
        yield* inboxStore.dropUnsent(session.id, failure?.message ?? "the session did not start")
      })

    const starting = <A, E, R>(start: Effect.Effect<A, E, R>) => start.pipe(Effect.onError((cause) => abandoned(cause)))

    return { launch, beforeStart, starting, deliver }
  }, provided)

  const projectName = (root: string) =>
    repositoryDirectoryName(root).pipe(
      Effect.catch(() => Effect.flatMap(Path.Path, (p) => Effect.succeed(p.basename(root)))),
    )

  const liveCount = (projectId: string) =>
    sessionStore.listSessions({ projectId }).pipe(Effect.map((rows) => rows.filter((row) => !archived(row)).length))

  const show = Effect.fn("Placement.show")(
    function* (h: Runtime, session: SessionRow, terminal: Terminal, root: string) {
      if (h.present === undefined) return
      yield* h.present(terminal, {
        agent: session.agent,
        harness: harnessIdOf(session),
        title: session.name,
        definition: session.agent,
        session: session.id,
        project: yield* projectName(root),
        live: String(yield* liveCount(session.projectId)),
      })
    },
    (effect) => Effect.ignore(effect),
    provided,
  )

  const undoOnFailure = <A, E, R, R2>(
    acquire: Effect.Effect<A, E, R>,
    undo: (a: A) => Effect.Effect<unknown, unknown, R2>,
  ) => Effect.acquireRelease(acquire, (a, exit) => (Exit.isFailure(exit) ? undo(a).pipe(Effect.ignore) : Effect.void))

  const nearCreator = (session: SessionRow, kind: string) =>
    Effect.gen(function* () {
      const creator = yield* sessionStore.creatorOf(session.id)

      const parent =
        creator !== undefined && "local" in creator ? yield* sessionStore.getSession(creator.local) : undefined

      const terminal = parent === undefined ? null : terminalOf(parent)

      return parent !== undefined && runtimeOf(parent) === kind && exitedAt(parent) === null && terminal !== null
        ? terminal.target
        : undefined
    })

  const ownTerminal = Effect.fn("Placement.ownTerminal")(function* (session: SessionRow) {
    const recorded = terminalOf(session)

    if (recorded === null) return undefined

    return (yield* sessionStore.lastSessionAt(recorded.runtime, recorded.target)) === session.id
      ? recorded.target
      : undefined
  })

  const terminalLocked =
    (session: SessionRow) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const recorded = terminalOf(session)

      return recorded === null ? effect : locks.withLock(terminalLock(recorded.runtime, recorded.target))(effect)
    }

  const closeLeftTerminal = Effect.fn("Placement.closeLeftTerminal")(function* (session: SessionRow) {
    if (exitedAt(session) === null) return

    yield* terminalLocked(session)(
      Effect.gen(function* () {
        const left = yield* ownTerminal(session)
        const owner = runtimes.find(runtimeOf(session))

        if (left === undefined || owner === undefined) return
        yield* owner.close(left).pipe(
          Effect.catchIf(
            (e) => e.code === "not_found",
            () => Effect.void,
          ),
        )
      }),
    )
  })

  const openTerminal = Effect.fn("Placement.openTerminal")(function* (
    h: Runtime,
    target: string | undefined,
    session: SessionRow,
    input: {
      readonly project: string
      readonly cwd: string
      readonly launch: (process: number | undefined) => Launch
      readonly near?: Terminal | undefined
      readonly split?: boolean | undefined
      readonly env?: Readonly<Record<string, string>> | undefined
      readonly endedByCaller?: boolean
      readonly beforeStart?: Effect.Effect<void>
    },
  ) {
    const remote = yield* sessionStore.startedByRemote(session.id)
    const creator = yield* nearCreator(session, h.id)

    const near =
      input.near !== undefined
        ? input.near
        : (creator ??
          (!remote && (target === undefined || target === "")
            ? yield* sessionStore.lastProjectTerminal(session.projectId, h.id)
            : undefined))

    yield* sessionStore.startProcess(session.id, startOf(session))

    if (input.beforeStart !== undefined) yield* input.beforeStart
    const started = yield* sessionStore.currentProcessId(session.id)
    const launch = input.launch(started)

    const opened = yield* h
      .open({
        project: input.project,
        cwd: input.cwd,
        launch: { ...launch, env: { ...input.env, ...launch.env } },
        label: session.name.slice(0, 60),
        ...(creator !== undefined && { parent: creator }),
        ...(near !== undefined && { near }),
        ...(input.split === true && { split: true }),
        ...(remote && { remote: true }),
        ...(target !== undefined && { target }),
      })
      .pipe(
        Effect.onError(() =>
          input.endedByCaller ? Effect.void : sessionStore.endProcess(session.id, "launch_failed"),
        ),
      )

    yield* sessionStore.placeProcess(session.id, opened)

    return opened
  }, provided)

  const shareRow = (session: SessionRow, splitFrom: string) =>
    Effect.gen(function* () {
      const sharedFrom = yield* sessionStore.getSession(splitFrom)

      if (sharedFrom === undefined)
        return yield* new NoSuchSession({ id: splitFrom, message: `--share ${splitFrom}: no session ${splitFrom}` })

      if (terminalOf(sharedFrom) === null)
        return yield* new NoSuchSession({
          id: splitFrom,
          message: `--share ${splitFrom}: it has no terminal in the runtime to open beside`,
        })

      return sharedFrom
    })

  const launchRaw = Effect.fnUntraced(function* (
    h: Runtime,
    target: string | undefined,
    session: SessionRow,
    root: string,
    firstPrompt: string,
    { splitFrom, env, commit, folders: pinned }: LaunchOptions,
  ) {
    const folders = pinned ?? (yield* listProjectRepositories(root))
    const sharedFrom = splitFrom !== undefined ? yield* shareRow(session, splitFrom) : undefined
    const near = sharedFrom === undefined ? undefined : terminalOf(sharedFrom)?.target
    yield* fs.makeDirectory(layout.artifacts(session.projectId), { recursive: true })

    const worktree = yield* worktreeOf(session)

    if (sharedFrom === undefined) {
      yield* undoOnFailure(Effect.void, () =>
        fs.readDirectory(worktree).pipe(
          Effect.flatMap((left) => (left.length === 0 ? fs.remove(worktree, { recursive: true }) : Effect.void)),
          Effect.ignore,
        ),
      )

      if (folders) {
        yield* undoOnFailure(createIsolatedWorktrees(folders, worktree), () => discardIsolatedWorktrees(worktree))
      } else {
        yield* undoOnFailure(addWorktree(root, worktree, commit), () => removeWorktree(root, worktree))
      }
    }

    if (!folders) yield* copyIncluded(root, worktree)
    yield* undoOnFailure(Effect.void, () => removeSystemPrompt(session.id))
    const plan = yield* launching(session, false, yield* taskInput(session, firstPrompt))

    const terminal = yield* undoOnFailure(
      plan.starting(
        openTerminal(h, target, session, {
          project: root,
          cwd: worktree,
          launch: plan.launch,
          beforeStart: plan.beforeStart,
          env,
          endedByCaller: true,
          ...(near !== undefined && { near }),
          ...(sharedFrom !== undefined && { split: true }),
        }),
      ),
      (terminal) => h.close(terminal).pipe(Effect.ignore),
    )

    yield* show(h, session, terminal, root)
    const notStarted = notStartedMessage(yield* plan.deliver(h, session, terminal))

    if (notStarted) yield* notice(session, notStarted)
  }, Effect.scoped)

  const launchFailed = Effect.fn("Placement.launchFailed")(function* (
    session: SessionRow,
    cause: Cause.Cause<unknown>,
  ) {
    const error = messageOf(Cause.squash(cause))
    const limit = yield* limitOf(session, error)
    const execution = yield* sessionStore.openExecution(session.id)

    if (execution !== undefined)
      yield* sessionStore.closeExecution(session.id, execution, "failed", { failure: limit?.failure })
    yield* sessionStore.endProcess(session.id, "launch_failed")
    yield* notice(
      session,
      `${sessionLabel(session)} failed to start ${harnessIdOf(session)}: ${limit === undefined ? error : limitText(limit.failure, limit.about)}`,
    )
  })

  const launch = Effect.fn("Placement.launch")(
    (
      h: Runtime,
      target: string | undefined,
      session: SessionRow,
      root: string,
      firstPrompt: string,
      options: LaunchOptions,
    ) =>
      launchRaw(h, target, session, root, firstPrompt, options).pipe(
        Effect.catchCause((cause) => launchFailed(session, cause)),
      ),
    provided,
  )

  const storedDirectory = (projectId: string) =>
    projectStore.projectDirectory(projectId).pipe(Effect.map((directory) => directory || undefined))

  const recount = Effect.fn("Placement.recount")(function* (kind: string, projectId: string) {
    const h = runtimes.find(kind)

    if (h === undefined) return

    const rows = (yield* sessionStore.listSessions({ projectId })).filter(
      (row) => runtimeOf(row) === kind && !archived(row),
    )

    const stored = yield* storedDirectory(projectId)

    for (const session of rows) {
      const terminal = terminalOf(session)

      if (terminal === null) continue
      yield* show(h, session, terminal.target, stored ?? (yield* projectRoot(yield* worktreeOf(session))).root)
    }
  }, provided)

  const locate = Effect.fn("Placement.locate")(function* (session: SessionRow) {
    const cwd = yield* worktreeOf(session)
    const stored = yield* storedDirectory(session.projectId)

    if (yield* listProjectRepositories(cwd)) return { root: stored ?? (yield* projectRoot(cwd)).root, cwd }

    return { root: stored ?? (yield* mainCheckout(cwd)), cwd }
  }, provided)

  const resume = Effect.fn("Placement.resume")(
    function* (h: Runtime, session: SessionRow, first?: FirstInput) {
      const { root, cwd } = yield* locate(session)
      const plan = yield* launching(session, true, first)

      const terminal = yield* plan.starting(
        undoOnFailure(
          openTerminal(h, undefined, session, {
            project: root,
            cwd,
            launch: plan.launch,
            beforeStart: plan.beforeStart,
          }),
          (terminal) => h.close(terminal).pipe(Effect.ignore),
        ).pipe(Effect.tap((terminal) => show(h, session, terminal, root))),
      )

      return notStartedMessage(yield* plan.deliver(h, session, terminal))
    },
    Effect.scoped,
    provided,
  )

  const republish = Effect.fn("Placement.republish")(function* () {
    const rows = (yield* sessionStore.listSessions()).filter((row) => !archived(row) && terminalOf(row) !== null)

    const labelled = yield* Effect.forEach(rows, (session) =>
      Effect.gen(function* () {
        const terminal = terminalOf(session)

        if (terminal === null) return 0
        const h = runtimes.find(terminal.runtime)

        if (h === undefined) return 0
        const stored = yield* storedDirectory(session.projectId)
        const root = stored ?? (yield* projectRoot(yield* worktreeOf(session))).root
        yield* show(h, session, terminal.target, root)

        return 1
      }).pipe(Effect.orElseSucceed(() => 0)),
    )

    return labelled.reduce((sum, n) => sum + n, 0)
  }, provided)

  return {
    notice,
    worktreeOf,
    systemPromptOf,
    launching,
    taskInput,
    launch,
    launchFailed,
    resume,
    republish,
    recount,
    openTerminal,
    closeLeftTerminal,
    ownTerminal,
    terminalLocked,
    show,
    locate,
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Placement") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Agents.node,
    ProjectStore.node,
    SessionStore.node,
    InboxStore.node,
    Executions.node,
    Git.node,
    Harness.node,
    Harnesses.node,
    Inbox.node,
    Runtimes.node,
    SessionLocks.node,
    Subscriptions.node,
    PlatformNode.childProcessSpawner,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
