import { shortId } from "@vibest/schema/id"
import { NoSuchSession } from "@vibest/schema/session"
import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  type Scope,
} from "effect"
import { ChildProcessSpawner } from "effect/process"

import { Agents } from "../agents.ts"
import { Db, type SessionRow } from "../db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import * as PlatformNode from "../effect/platform.ts"
import { encodeCommand, Harness, Harnesses, type HarnessUnavailable } from "../harness.ts"
import { Inbox } from "../inbox.ts"
import { definitionIn } from "../launch.ts"
import { Layout, VibestCommand } from "../paths.ts"
import { messageOf } from "../plugin-sources.ts"
import {
  createIsolatedWorktrees,
  discardIsolatedWorktrees,
  listProjectRepositories,
  projectRoot,
} from "../project-create.ts"
import { isUsageLimitError } from "../replies.ts"
import { addressOf, RuntimeError, Runtimes, type Runtime, type Terminal } from "../runtimes.ts"
import { projectText, removeSystemPrompt, systemPrompt, writeSystemPrompt } from "../system-prompt.ts"
import { addWorktree, copyIncluded, Git, mainCheckout, removeWorktree, repositoryDirectoryName } from "../worktree.ts"
import { Executions } from "./executions.ts"
import type { LimitMove } from "./move.ts"

export const runtimeEnv = (runtime: string, address: { readonly machine: string; readonly id: string }) =>
  JSON.stringify({ runtime, machine: address.machine, ...(address.id !== "" ? { terminal: address.id } : {}) })

class AgentOwnLimit extends Data.TaggedError("AgentOwnLimit")<{ readonly message: string }> {}

export type LaunchOptions = {
  readonly splitFrom?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly commit?: string | undefined
  readonly onOwnLimit: LimitMove["rerun"]
}

const make = Effect.gen(function* () {
  const db = yield* Db
  const runtimes = yield* Runtimes
  const harness = yield* Harness
  const harnesses = yield* Harnesses
  const agents = yield* Agents
  const inbox = yield* Inbox
  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const git = yield* Git
  const vibest = yield* VibestCommand
  const { prompt } = yield* Executions

  const provided = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Git>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Git, git),
    )

  const notice = Effect.fn("Placement.notice")((session: SessionRow, message: string) =>
    inbox.enqueue({ sessionId: session.id, message }),
  )

  const worktreeOf = Effect.fn("Placement.worktreeOf")((session: SessionRow) =>
    db.sessionDirectory(session.id).pipe(
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
    ...(process === undefined ? {} : { VIBEST_PROCESS: String(process) }),
    VIBEST_SESSION_ID: session.id,
    VIBEST_PROJECT_ID: session.projectId,
    VIBEST_PROJECT_DIR: layout.project(session.projectId),
    VIBEST_HARNESS: session.harnessId,
    VIBEST_RUNTIME: runtimeEnv(session.runtime, { machine: session.address.machine, id: "" }),
    VIBEST_HOME: layout.home,
    VIBEST_COMMAND: encodeCommand(vibest),
  })

  const systemPromptOf = Effect.fn("Placement.systemPromptOf")(function* (session: SessionRow) {
    return systemPrompt({
      system: (yield* definitionIn(agents, session.agent)).system,
      id: session.id,
      checkout: (yield* db.sessionIdentity(session.id))?.entry,
      sharer: yield* db.earlierSharer(session.id),
      creator: yield* db.creatorLabel(session.id),
      projectDir: layout.project(session.projectId),
      vibest,
      ...(yield* projectText(layout.project(session.projectId))),
    })
  }, provided)

  const launchArgv = Effect.fn("Placement.launchArgv")(function* (session: SessionRow, resume: boolean) {
    const file = yield* systemPromptOf(session).pipe(Effect.flatMap((text) => writeSystemPrompt(session.id, text)))
    const adapter = yield* harnesses.get(session.harnessId)
    const pluginDir = yield* harness.plugin(adapter.id)
    const id = session.harnessSessionId
    const resumeThis = resume && id !== null && (yield* db.canResumeConversation(session.id, id))
    return [
      adapter.binary,
      ...adapter.launchArgs({
        worktree: yield* worktreeOf(session),
        projectDir: layout.project(session.projectId),
        systemPromptFile: file,
        provider: session.provider,
        model: session.model,
        sessionId: id,
        resume: resumeThis,
        pluginDir,
        vibest,
        env: vibestEnv(session),
      }),
    ]
  }, provided)

  const handTask = Effect.fn("Placement.handTask")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    task: string,
  ) {
    const first = (yield* harnesses.get(session.harnessId)).systemPromptInPrompt
      ? `${yield* systemPromptOf(session)}\n\n# Task\n\n${task}`
      : task
    const notStarted = yield* prompt(h, session, terminal, first, db.linkTask(session.id))
    if (notStarted) yield* notice(session, notStarted)
  }, provided)

  const afterOpen = (h: Runtime, session: SessionRow, terminal: Terminal, root: string, firstPrompt: string) =>
    Effect.gen(function* () {
      yield* show(h, session, terminal, root)
      yield* handTask(h, session, terminal, firstPrompt)
    })

  const projectName = (root: string) =>
    repositoryDirectoryName(root).pipe(
      Effect.catch(() => Effect.flatMap(Path.Path, (p) => Effect.succeed(p.basename(root)))),
    )

  const liveCount = (projectId: string) =>
    db
      .listSessions({ projectId })
      .pipe(
        Effect.map(
          (rows) => rows.filter((row) => !row.entry && !(row.metadata.archived || row.metadata.removed)).length,
        ),
      )

  const show = Effect.fn("Placement.show")(
    function* (h: Runtime, session: SessionRow, terminal: Terminal, root: string) {
      if (h.present === undefined) return
      yield* h.present(terminal, {
        agent: session.agent,
        harness: session.harnessId,
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
      const creator = yield* db.creatorOf(session.id)
      const parent = creator !== undefined && "local" in creator ? yield* db.getSession(creator.local) : undefined
      return parent?.runtime === kind && parent.exitedAt === null && parent.address.id !== ""
        ? parent.address
        : undefined
    })

  const openTerminal = Effect.fn("Placement.openTerminal")(function* (
    h: Runtime,
    target: string | undefined,
    session: SessionRow,
    input: {
      readonly project: string
      readonly cwd: string
      readonly argv: ReadonlyArray<string>
      readonly near?: Terminal | undefined
      readonly split?: boolean | undefined
      readonly env?: Readonly<Record<string, string>> | undefined
      readonly endedByCaller?: boolean
    },
  ) {
    const near = input.near !== undefined ? input.near : yield* nearCreator(session, h.id)
    const remote = yield* db.startedByPeer(session.id)
    const choice = {
      harnessId: session.harnessId,
      provider: session.provider,
      model: session.model,
      harnessSessionId: session.harnessSessionId,
    }
    const ended = ((yield* db.getSession(session.id))?.exitedAt ?? null) !== null
    yield* db.updateSession(session.id, {
      ...choice,
      address: { machine: session.address.machine, id: "" },
      ...(ended ? { startedAt: yield* Clock.currentTimeMillis } : {}),
    })
    const started = yield* db.currentProcessId(session.id)
    const opened = yield* h
      .open({
        project: input.project,
        cwd: input.cwd,
        argv: input.argv,
        env: { ...input.env, ...vibestEnv(session, started) },
        label: `${shortId(session.id)} ${session.name}`.slice(0, 60),
        ...(near !== undefined ? { near } : {}),
        ...(input.split === true ? { split: true } : {}),
        ...(remote ? { remote: true } : {}),
        ...(target !== undefined ? { target } : {}),
      })
      .pipe(Effect.onError(() => (input.endedByCaller ? Effect.void : db.endProcess(session.id, "launch_failed"))))
    const terminal = addressOf(opened)
    yield* db.placeProcess(session.id, terminal.id)
    return terminal
  }, provided)

  const shareRow = (session: SessionRow, splitFrom: string) =>
    Effect.gen(function* () {
      const sharedFrom = yield* db.getSession(splitFrom)
      if (sharedFrom === undefined)
        return yield* new NoSuchSession({ id: splitFrom, message: `--share ${splitFrom}: no session ${splitFrom}` })
      if (sharedFrom.address.id === "")
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
    { splitFrom, env, commit, onOwnLimit }: LaunchOptions,
  ) {
    const folders = yield* listProjectRepositories(root)
    const sharedFrom = splitFrom !== undefined ? yield* shareRow(session, splitFrom) : undefined
    const near = sharedFrom?.address
    yield* fs.makeDirectory(layout.artifacts(session.projectId), { recursive: true })
    const openOrMove = (
      open: Effect.Effect<
        Terminal,
        RuntimeError | HarnessUnavailable | NoSuchSession | PlatformError.PlatformError,
        Scope.Scope
      >,
    ) =>
      undoOnFailure(
        open.pipe(
          Effect.catchTag("RuntimeError", (e): Effect.Effect<never, AgentOwnLimit | RuntimeError> =>
            e.code === "failed" && isUsageLimitError(e.message)
              ? Effect.fail(new AgentOwnLimit({ message: e.message }))
              : Effect.fail(e),
          ),
        ),
        (terminal) => h.close(terminal).pipe(Effect.ignore),
      ).pipe(
        Effect.catchTag("AgentOwnLimit", (e) =>
          onOwnLimit(h, session, undefined, firstPrompt, false, e.message, 0).pipe(
            Effect.map((): Option.Option<Terminal> => Option.none<Terminal>()),
          ),
        ),
        Effect.map((outcome) => (Option.isOption(outcome) ? outcome : Option.some<Terminal>(outcome))),
      )
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
    const argv = yield* launchArgv(session, false)
    const terminal = yield* openOrMove(
      openTerminal(h, target, session, {
        project: root,
        cwd: worktree,
        argv,
        env,
        endedByCaller: true,
        ...(near !== undefined ? { near } : {}),
        ...(sharedFrom !== undefined ? { split: true } : {}),
      }),
    )
    if (Option.isNone(terminal)) return
    return yield* afterOpen(h, session, terminal.value, root, firstPrompt)
  }, Effect.scoped)
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
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const e = Cause.squash(cause)
            const t = yield* Clock.currentTimeMillis
            const execution = yield* db.openExecution(session.id)
            if (execution !== undefined) yield* db.closeExecution(session.id, execution, "failed")
            yield* db.updateSession(session.id, {
              status: "unknown",
              exitedAt: t,
              lastActive: t,
              end: "launch_failed",
            })
            yield* notice(session, `${session.id} failed to start ${session.harnessId}: ${messageOf(e)}`)
          }),
        ),
      ),
    provided,
  )

  const storedDirectory = (projectId: string) =>
    db.projectDirectory(projectId).pipe(Effect.map((directory) => directory || undefined))

  const recount = Effect.fn("Placement.recount")(function* (kind: string, projectId: string) {
    const h = runtimes.find(kind)
    if (h === undefined) return
    const rows = (yield* db.listSessions({ projectId })).filter(
      (row) => !row.entry && row.runtime === kind && !(row.metadata.archived || row.metadata.removed),
    )
    const stored = yield* storedDirectory(projectId)
    let shown = false
    for (const session of rows) {
      if (session.address.id === "") continue
      yield* show(h, session, session.address, stored ?? (yield* projectRoot(yield* worktreeOf(session))).root)
      shown = true
    }
    if (shown) return
    const entry = yield* db.entryOf(projectId)
    if (entry?.runtime !== kind || !entry.address || entry.address.id === "" || stored === undefined) return
    if (h.present === undefined) return
    yield* h
      .present(entry.address, {
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
    function* (h: Runtime, session: SessionRow) {
      const { root, cwd } = yield* locate(session)
      const terminal = yield* undoOnFailure(
        launchArgv(session, true).pipe(
          Effect.flatMap((argv) => openTerminal(h, undefined, session, { project: root, cwd, argv })),
        ),
        (terminal) => h.close(terminal).pipe(Effect.ignore),
      )
      yield* show(h, session, terminal, root)
    },
    Effect.scoped,
    provided,
  )

  const republish = Effect.fn("Placement.republish")(function* () {
    const rows = (yield* db.listSessions()).filter(
      (row) => !row.entry && !(row.metadata.archived || row.metadata.removed) && row.address.id !== "",
    )
    const labelled = yield* Effect.forEach(rows, (session) =>
      Effect.gen(function* () {
        const h = runtimes.find(session.runtime)
        if (h === undefined) return 0
        const stored = yield* storedDirectory(session.projectId)
        const root = stored ?? (yield* projectRoot(yield* worktreeOf(session))).root
        yield* show(h, session, session.address, root)
        return 1
      }).pipe(Effect.orElseSucceed(() => 0)),
    )
    return labelled.reduce((sum, n) => sum + n, 0)
  }, provided)

  return {
    notice,
    worktreeOf,
    systemPromptOf,
    launchArgv,
    handTask,
    launch,
    resume,
    republish,
    recount,
    openTerminal,
    show,
    locate,
  }
})

export class Placement extends Context.Service<Placement, Effect.Success<typeof make>>()("vibest/Placement") {
  static readonly make = make

  static readonly layer = Layer.effect(Placement, make)

  static readonly node = LayerNode.make({
    service: Placement,
    layer: Placement.layer,
    deps: [
      Agents.node,
      Db.node,
      Executions.node,
      Git.node,
      Harness.node,
      Harnesses.node,
      Inbox.node,
      Runtimes.node,
      PlatformNode.childProcessSpawner,
      PlatformNode.crypto,
      PlatformNode.fileSystem,
      PlatformNode.layout,
      PlatformNode.path,
    ],
  })
}
