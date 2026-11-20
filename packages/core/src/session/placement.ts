import { Harness as PluginHarness } from "@vibest/plugin/effect"
import { messageOf } from "@vibest/schema/error"
import { sessionLabel, shortId } from "@vibest/schema/id"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { NoSuchSession } from "@vibest/schema/session"
import { Cause, Clock, Context, Effect, Exit, FileSystem, Layer, Path, Ref } from "effect"
import { ChildProcessSpawner } from "effect/process"

import { Agents } from "../agents.ts"
import {
  type SessionRow,
  harnessIdOf,
  placedTerminal,
  runtimeOf,
  startOf,
  terminalOf,
  exitedAt,
  archived,
  limitFailure,
  limitText,
  type ExecutionFailure,
  type LimitAbout,
} from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Git } from "../git.ts"
import { cliEnv, Harness } from "../harness.ts"
import { Harnesses } from "../harnesses.ts"
import { Inbox } from "../inbox.ts"
import { definitionIn, withProcess, type Launch } from "../launch.ts"
import {
  createIsolatedWorktrees,
  discardIsolatedWorktrees,
  listProjectRepositories,
  type PinnedFolder,
  projectRoot,
} from "../project/create.ts"
import { isUsageLimitError } from "../replies.ts"
import { addressOf, Runtimes, type Runtime, type Terminal } from "../runtimes.ts"
import { limitSeen, Subscriptions } from "../subscriptions/service.ts"
import { projectText, removeSystemPrompt, systemPrompt, withTask, writeSystemPrompt } from "../system-prompt.ts"
import { addWorktree, copyIncluded, mainCheckout, removeWorktree, repositoryDirectoryName } from "../worktree.ts"
import { Executions, notStartedMessage, Pickup } from "./executions.ts"

export * as Placement from "./placement.ts"

export const runtimeEnv = (runtime: string, address: { readonly machine: string; readonly id: string }) =>
  JSON.stringify({ runtime, machine: address.machine, ...(address.id !== "" && { terminal: address.id }) })

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
  const db = yield* Db.Service
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
    db.session.sessionDirectory(session.id).pipe(
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
    VIBEST_HARNESS: harnessIdOf(session),
    VIBEST_RUNTIME: runtimeEnv(runtimeOf(session), { machine: terminalOf(session).machine, id: "" }),
    VIBEST_HOME: layout.home,
  })

  const systemPromptOf = Effect.fn("Placement.systemPromptOf")(function* (session: SessionRow) {
    return systemPrompt({
      system: (yield* definitionIn(agents, session.agent)).system,
      id: session.id,
      checkout: (yield* db.session.sessionIdentity(session.id))?.entry,
      sharer: yield* db.session.earlierSharer(session.id),
      creator: yield* db.session.creatorLabel(session.id),
      projectDir: layout.project(session.projectId),
      agents: agents.all,
      ...(yield* projectText(layout.project(session.projectId))),
    })
  }, provided)

  const launchOf = Effect.fn("Placement.launchOf")(function* (session: SessionRow, resume: boolean, first?: string) {
    const system = yield* systemPromptOf(session)
    const adapter = yield* harnesses.get(harnessIdOf(session))
    const pluginDir = yield* harness.plugin(adapter.id)
    const id = session.process?.conversation ?? null
    const resumeThis = resume && id !== null && (yield* db.session.canResumeConversation(session.id, id))
    const env = { ...vibestEnv(session), ...(yield* cliEnv(vibest, adapter.id)) }

    return {
      harness: adapter.id,
      argv: PluginHarness.harnessArgv(
        adapter,
        {
          worktree: yield* worktreeOf(session),
          projectDir: layout.project(session.projectId),
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
    Effect.map(firstText(session, task), (text): FirstInput => ({ text, onHandover: db.inbox.linkTask(session.id) }))

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
    const launch = (process: number | undefined) => withProcess(base, process)
    const execution = yield* Ref.make<number | undefined>(undefined)

    const beforeStart =
      first === undefined
        ? Effect.void
        : Effect.flatMap(openFirst(session.id, first.onHandover), (opened) => Ref.set(execution, opened))

    const deliver = (h: Runtime, row: SessionRow, terminal: Terminal) =>
      Effect.flatMap(Ref.get(execution), (opened) =>
        opened === undefined ? Effect.succeed(Pickup.Taken()) : launched(h, row, terminal, opened),
      )

    const abandoned = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const opened = yield* Ref.get(execution)

        if (opened === undefined) return
        const failure = (yield* limitOf(session, messageOf(Cause.squash(cause))))?.failure
        yield* db.session.closeExecution(session.id, opened, failure === undefined ? "not_started" : "failed", {
          failure,
        })
      })

    const starting = <A, E, R>(start: Effect.Effect<A, E, R>) => start.pipe(Effect.onError((cause) => abandoned(cause)))

    return { launch, beforeStart, starting, deliver }
  }, provided)

  const projectName = (root: string) =>
    repositoryDirectoryName(root).pipe(
      Effect.catch(() => Effect.flatMap(Path.Path, (p) => Effect.succeed(p.basename(root)))),
    )

  const liveCount = (projectId: string) =>
    db.session
      .listSessions({ projectId })
      .pipe(Effect.map((rows) => rows.filter((row) => !row.entry && !archived(row)).length))

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
      const creator = yield* db.session.creatorOf(session.id)

      const parent =
        creator !== undefined && "local" in creator ? yield* db.session.getSession(creator.local) : undefined

      return parent !== undefined &&
        runtimeOf(parent) === kind &&
        exitedAt(parent) === null &&
        terminalOf(parent).id !== ""
        ? terminalOf(parent)
        : undefined
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
    const near = input.near !== undefined ? input.near : yield* nearCreator(session, h.id)
    const remote = yield* db.session.startedByPeer(session.id)
    yield* db.session.startProcess(session.id, startOf(session))

    if (input.beforeStart !== undefined) yield* input.beforeStart
    const started = yield* db.session.currentProcessId(session.id)
    const launch = input.launch(started)

    const opened = yield* h
      .open({
        project: input.project,
        cwd: input.cwd,
        launch: { ...launch, env: { ...input.env, ...launch.env } },
        label: `${shortId(session.id)} ${session.name}`.slice(0, 60),
        ...(near !== undefined && { near }),
        ...(input.split === true && { split: true }),
        ...(remote && { remote: true }),
        ...(target !== undefined && { target }),
      })
      .pipe(
        Effect.onError(() => (input.endedByCaller ? Effect.void : db.session.endProcess(session.id, "launch_failed"))),
      )

    const terminal = addressOf(opened)
    yield* db.session.placeProcess(session.id, terminal.id)

    return terminal
  }, provided)

  const shareRow = (session: SessionRow, splitFrom: string) =>
    Effect.gen(function* () {
      const sharedFrom = yield* db.session.getSession(splitFrom)

      if (sharedFrom === undefined)
        return yield* new NoSuchSession({ id: splitFrom, message: `--share ${splitFrom}: no session ${splitFrom}` })

      if (terminalOf(sharedFrom).id === "")
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
    const near = sharedFrom === undefined ? undefined : terminalOf(sharedFrom)
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
    const execution = yield* db.session.openExecution(session.id)

    if (execution !== undefined)
      yield* db.session.closeExecution(session.id, execution, "failed", { failure: limit?.failure })
    yield* db.session.endProcess(session.id, "launch_failed")
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
    db.project.projectDirectory(projectId).pipe(Effect.map((directory) => directory || undefined))

  const recount = Effect.fn("Placement.recount")(function* (kind: string, projectId: string) {
    const h = runtimes.find(kind)

    if (h === undefined) return

    const rows = (yield* db.session.listSessions({ projectId })).filter(
      (row) => !row.entry && runtimeOf(row) === kind && !archived(row),
    )

    const stored = yield* storedDirectory(projectId)
    let shown = false

    for (const session of rows) {
      if (terminalOf(session).id === "") continue
      yield* show(h, session, terminalOf(session), stored ?? (yield* projectRoot(yield* worktreeOf(session))).root)
      shown = true
    }

    if (shown) return
    const entry = yield* db.session.entryOf(projectId)
    const place = entry === undefined ? undefined : placedTerminal(entry)

    if (place?.runtime !== kind || stored === undefined) return

    if (h.present === undefined) return
    yield* h
      .present(place.address, {
        agent: "",
        harness: "",
        title: "",
        definition: "",
        session: "",
        project: yield* projectName(stored),
        live: String(rows.length),
      })
      .pipe(Effect.ignore)
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
    const rows = (yield* db.session.listSessions()).filter(
      (row) => !row.entry && !archived(row) && terminalOf(row).id !== "",
    )

    const labelled = yield* Effect.forEach(rows, (session) =>
      Effect.gen(function* () {
        const h = runtimes.find(runtimeOf(session))

        if (h === undefined) return 0
        const stored = yield* storedDirectory(session.projectId)
        const root = stored ?? (yield* projectRoot(yield* worktreeOf(session))).root
        yield* show(h, session, terminalOf(session), root)

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
    Db.node,
    Executions.node,
    Git.node,
    Harness.node,
    Harnesses.node,
    Inbox.node,
    Runtimes.node,
    Subscriptions.node,
    PlatformNode.childProcessSpawner,
    PlatformNode.crypto,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
