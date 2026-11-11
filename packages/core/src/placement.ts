import { shortId } from "@vibest/schema/id"
import { NoSuchSession, NotReady } from "@vibest/schema/session"
import {
  Cause,
  Clock,
  type Config,
  Data,
  Effect,
  Exit,
  type FileSystem,
  Option,
  Path,
  type PlatformError,
  type Scope,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"

import type { CoordinatorRow, ProcessEndReason, SessionPatch, SessionRow } from "./db.ts"
import type { HarnessUnavailable } from "./harness.ts"
import type { LimitMove } from "./move.ts"
import { messageOf } from "./plugin-sources.ts"
import {
  createIsolatedWorktrees,
  discardIsolatedWorktrees,
  listProjectRepositories,
  projectRoot,
} from "./project-create.ts"
import { isUsageLimitError } from "./replies.ts"
import { addressOf, type RuntimesShape, type Runtime, type Terminal } from "./runtimes.ts"
import { RuntimeError } from "./runtimes.ts"
import { removeSystemPrompt, type SystemPromptDirUnsafe } from "./system-prompt.ts"
import {
  addWorktree,
  copyIncluded,
  type Git,
  mainCheckout,
  removeWorktree,
  repositoryDirectoryName,
} from "./worktree.ts"

class AgentOwnLimit extends Data.TaggedError("AgentOwnLimit")<{ readonly message: string }> {}

export type LaunchOptions = {
  readonly splitFrom?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly commit?: string | undefined
}

export const sessionPlacement = (deps: {
  readonly db: {
    readonly coordinatorOf: (projectId: string) => Effect.Effect<CoordinatorRow | undefined>
    readonly listSessions: (filter?: { readonly projectId?: string }) => Effect.Effect<ReadonlyArray<SessionRow>>
    readonly openExecution: (id: string) => Effect.Effect<number | undefined>
    readonly closeExecution: (id: string, execution: number, status: "failed") => Effect.Effect<boolean>
    readonly getSession: (id: string) => Effect.Effect<SessionRow | undefined>
    readonly updateSession: (id: string, patch: SessionPatch) => Effect.Effect<void>
    readonly endProcess: (id: string, reason: ProcessEndReason) => Effect.Effect<boolean>
    readonly startedByPeer: (id: string) => Effect.Effect<boolean>
    readonly currentProcessId: (id: string) => Effect.Effect<number | undefined>
  }
  readonly runtimes: RuntimesShape
  readonly layout: {
    readonly artifacts: (projectId: string) => string
  }
  readonly fs: {
    readonly makeDirectory: (
      path: string,
      options?: { readonly recursive?: boolean },
    ) => Effect.Effect<void, PlatformError.PlatformError>
    readonly remove: (
      path: string,
      options?: { readonly force?: boolean; readonly recursive?: boolean },
    ) => Effect.Effect<void, PlatformError.PlatformError>
    readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>
  }
  readonly path: { readonly dirname: (path: string) => string }
  readonly worktreeOf: (session: SessionRow) => Effect.Effect<string, NoSuchSession>
  readonly vibestEnv: (session: SessionRow, process?: number) => Readonly<Record<string, string>>
  readonly launchArgv: (
    session: SessionRow,
    resume: boolean,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    HarnessUnavailable | NoSuchSession | PlatformError.PlatformError | SystemPromptDirUnsafe | Config.ConfigError
  >
  readonly notice: (session: SessionRow, message: string) => Effect.Effect<unknown>
  readonly prompt: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
    onHandover?: Effect.Effect<void>,
  ) => Effect.Effect<string | undefined, NotReady | unknown, FileSystem.FileSystem>
  readonly afterOpen: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    root: string,
    firstPrompt: string,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path | Git>
  readonly limitMove: Pick<LimitMove, "rerun">
}) => {
  const { db, runtimes, layout, fs } = deps
  const projectName = (root: string) =>
    repositoryDirectoryName(root).pipe(
      Effect.catch(() => Effect.flatMap(Path.Path, (p) => Effect.succeed(p.basename(root)))),
    )

  const liveCount = (projectId: string) =>
    db
      .listSessions({ projectId })
      .pipe(Effect.map((rows) => rows.filter((row) => !(row.metadata.archived || row.metadata.removed)).length))

  const show = (h: Runtime, session: SessionRow, terminal: Terminal, root: string) =>
    Effect.gen(function* () {
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
    }).pipe(Effect.ignore)

  const undoOnFailure = <A, E, R, R2>(
    acquire: Effect.Effect<A, E, R>,
    undo: (a: A) => Effect.Effect<unknown, unknown, R2>,
  ) => Effect.acquireRelease(acquire, (a, exit) => (Exit.isFailure(exit) ? undo(a).pipe(Effect.ignore) : Effect.void))

  const nearMain = (session: SessionRow, kind: string) =>
    db
      .coordinatorOf(session.projectId)
      .pipe(
        Effect.map((main) =>
          main?.runtime === kind && main.address !== null && main.address.id !== "" ? main.address : undefined,
        ),
      )

  const openTerminal = Effect.fn("Sessions.openTerminal")(function* (
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
    const near = input.near !== undefined ? input.near : yield* nearMain(session, h.id)
    const remote = yield* db.startedByPeer(session.id)
    const choice = {
      harnessId: session.harnessId,
      provider: session.provider,
      model: session.model,
      harnessSessionId: session.harnessSessionId,
    }
    yield* db.updateSession(session.id, { ...choice, address: { machine: session.address.machine, id: "" } })
    const started = yield* db.currentProcessId(session.id)
    const opened = yield* h
      .open({
        project: input.project,
        cwd: input.cwd,
        argv: input.argv,
        env: { ...input.env, ...deps.vibestEnv(session, started) },
        label: `${shortId(session.id)} ${session.name}`.slice(0, 60),
        ...(near !== undefined ? { near } : {}),
        ...(input.split === true ? { split: true } : {}),
        ...(remote ? { remote: true } : {}),
        ...(target !== undefined ? { target } : {}),
      })
      .pipe(Effect.onError(() => (input.endedByCaller ? Effect.void : db.endProcess(session.id, "launch_failed"))))
    const terminal = addressOf(opened)
    const at = yield* Clock.currentTimeMillis
    yield* db.updateSession(session.id, { ...choice, address: terminal, startedAt: at, exitedAt: null })
    return terminal
  })

  const peerRow = (session: SessionRow, splitFrom: string) =>
    Effect.gen(function* () {
      const peer = yield* db.getSession(splitFrom)
      if (peer === undefined)
        return yield* new NoSuchSession({ id: splitFrom, message: `--peer ${splitFrom}: no session ${splitFrom}` })
      if (peer.address.id === "")
        return yield* new NoSuchSession({
          id: splitFrom,
          message: `--peer ${splitFrom}: it has no terminal in the runtime to open beside`,
        })
      return peer
    })

  const launchRaw = Effect.fn("Sessions.launch")(function* (
    h: Runtime,
    target: string | undefined,
    session: SessionRow,
    root: string,
    firstPrompt: string,
    { splitFrom, env, commit }: LaunchOptions = {},
  ) {
    const folders = yield* listProjectRepositories(root)
    const peer = splitFrom !== undefined ? yield* peerRow(session, splitFrom) : undefined
    const near = peer?.address
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
          deps.limitMove
            .rerun(h, session, undefined, firstPrompt, false, e.message, 0)
            .pipe(Effect.map((): Option.Option<Terminal> => Option.none<Terminal>())),
        ),
        Effect.map((outcome) => (Option.isOption(outcome) ? outcome : Option.some<Terminal>(outcome))),
      )
    const worktree = yield* deps.worktreeOf(session)
    if (peer === undefined) {
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
    const argv = yield* deps.launchArgv(session, false)
    const terminal = yield* openOrMove(
      openTerminal(h, target, session, {
        project: root,
        cwd: worktree,
        argv,
        env,
        endedByCaller: true,
        ...(near !== undefined ? { near } : {}),
        ...(peer !== undefined ? { split: true } : {}),
      }),
    )
    if (Option.isNone(terminal)) return
    return yield* deps.afterOpen(h, session, terminal.value, root, firstPrompt)
  }, Effect.scoped)
  const launch = (
    h: Runtime,
    target: string | undefined,
    session: SessionRow,
    root: string,
    firstPrompt: string,
    options: LaunchOptions = {},
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
          yield* deps.notice(session, `${session.id} failed to start ${session.harnessId}: ${messageOf(e)}`)
        }),
      ),
    )

  const storedDirectory = (projectId: string) =>
    db.coordinatorOf(projectId).pipe(Effect.map((main) => main?.projectDirectory))

  const recount = Effect.fn("Sessions.recount")(function* (kind: string, projectId: string) {
    const h = runtimes.find(kind)
    if (h === undefined) return
    const rows = (yield* db.listSessions({ projectId })).filter(
      (row) => row.runtime === kind && !(row.metadata.archived || row.metadata.removed),
    )
    const stored = yield* storedDirectory(projectId)
    let shown = false
    for (const session of rows) {
      if (session.address.id === "") continue
      yield* show(h, session, session.address, stored ?? (yield* projectRoot(yield* deps.worktreeOf(session))).root)
      shown = true
    }
    if (shown) return
    const main = yield* db.coordinatorOf(projectId)
    if (main?.runtime !== kind || !main.address || main.address.id === "" || stored === undefined) return
    if (h.present === undefined) return
    yield* h
      .present(main.address, {
        agent: "",
        harness: "",
        title: "",
        definition: "",
        session: "",
        project: yield* projectName(stored),
        live: String(rows.length),
      })
      .pipe(Effect.ignore)
  })

  const locate = (session: SessionRow) =>
    Effect.gen(function* () {
      const cwd = yield* deps.worktreeOf(session)
      const stored = yield* storedDirectory(session.projectId)
      if (yield* listProjectRepositories(cwd)) return { root: stored ?? (yield* projectRoot(cwd)).root, cwd }
      return { root: stored ?? (yield* mainCheckout(cwd)), cwd }
    })

  const resume = Effect.fn("Sessions.resume")(function* (h: Runtime, session: SessionRow) {
    const { root, cwd } = yield* locate(session)
    const terminal = yield* undoOnFailure(
      deps
        .launchArgv(session, true)
        .pipe(Effect.flatMap((argv) => openTerminal(h, undefined, session, { project: root, cwd, argv }))),
      (terminal) => h.close(terminal).pipe(Effect.ignore),
    )
    yield* show(h, session, terminal, root)
  }, Effect.scoped)

  const republish = Effect.fn("Sessions.republish")(function* () {
    const rows = (yield* db.listSessions()).filter(
      (row) => !(row.metadata.archived || row.metadata.removed) && row.address.id !== "",
    )
    const labelled = yield* Effect.forEach(rows, (session) =>
      Effect.gen(function* () {
        const h = runtimes.find(session.runtime)
        if (h === undefined) return 0
        const stored = yield* storedDirectory(session.projectId)
        const root = stored ?? (yield* projectRoot(yield* deps.worktreeOf(session))).root
        yield* show(h, session, session.address, root)
        return 1
      }).pipe(Effect.orElseSucceed(() => 0)),
    )
    return labelled.reduce((sum, n) => sum + n, 0)
  })

  return { launch, resume, republish, recount, openTerminal, show, locate }
}
