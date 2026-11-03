import { NoSuchSession, NotReady } from "@vibest/schema/session"
// Where a session's terminal goes, and the labels the runtime shows on it. `root` is a project directory, never the
// project key. Placement is the runtime's (runtime-port.md §3): core asks for a terminal running the harness argv,
// kept beside the project's other terminals (`near`), and labels it with `present` when the runtime has one.
import { Cause, Clock, Data, Effect, Exit, type FileSystem, Option, Path, type PlatformError, type Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"

import type { CoordinatorRow, EndReason, SessionPatch, SessionRow } from "./db.ts"
import type { HarnessUnavailable } from "./harness.ts"
import type { LimitMove } from "./move.ts"
import { writeAtomic } from "./paths.ts"
import {
  createIsolatedWorktrees,
  discardIsolatedWorktrees,
  listProjectRepositories,
  projectRoot,
} from "./project-create.ts"
import { isUsageLimitError } from "./results.ts"
import { projectText, sessionRules } from "./rules.ts"
import { type Machine, type RuntimesShape, type Runtime, type Terminal } from "./runtimes.ts"
import { RuntimeError } from "./runtimes.ts"
import { addWorktree, copyIncluded, git, mainCheckout, repositoryDirectoryName } from "./worktree.ts"

/** The harness dying on its own usage limit inside `open` (§3): the launch hands over to the limit move, as a failed start did. */
class AgentOwnLimit extends Data.TaggedError("AgentOwnLimit")<{ readonly message: string }> {}

export const sessionPlacement = (deps: {
  readonly db: {
    readonly coordinatorOf: (projectId: number) => Effect.Effect<CoordinatorRow | undefined>
    readonly listSessions: (filter?: { readonly projectId?: number }) => Effect.Effect<ReadonlyArray<SessionRow>>
    readonly projectKey: (id: number) => Effect.Effect<string | undefined>
    readonly closeTurn: (id: string, end: "failed", patch: SessionPatch) => Effect.Effect<void>
    /** The row of `--peer`'s named session. */
    readonly getSession: (id: string) => Effect.Effect<SessionRow | undefined>
    readonly earlierSharer: (id: string) => Effect.Effect<string | undefined>
    readonly updateSession: (id: string, patch: SessionPatch) => Effect.Effect<void>
    readonly endProcess: (id: string, reason: EndReason) => Effect.Effect<boolean>
  }
  /** The registry every row's `runtime.kind` routes through. */
  readonly runtimes: RuntimesShape
  readonly layout: {
    readonly scratch: (key: string) => string
    readonly rulesFile: (id: string) => string
    readonly project: (key: string) => string
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
  readonly vibest: ReadonlyArray<string>
  readonly harnesses: { readonly get: (id: SessionRow["harnessId"]) => { readonly rulesInPrompt: boolean } }
  readonly worktreeOf: (session: SessionRow) => Effect.Effect<string, NoSuchSession>
  readonly vibestEnv: (session: SessionRow, scratch: string) => Readonly<Record<string, string>>
  /** The harness argv a terminal runs (sessions.ts `launchArgv`). */
  readonly launchArgv: (
    session: SessionRow,
    resume: boolean,
    key: string,
  ) => Effect.Effect<ReadonlyArray<string>, HarnessUnavailable | NoSuchSession | PlatformError.PlatformError>
  readonly notice: (session: SessionRow, message: string) => Effect.Effect<unknown>
  readonly prompt: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
    onHandover?: Effect.Effect<void>,
    options?: { readonly keepRound?: boolean },
  ) => Effect.Effect<string | undefined, NotReady | unknown, FileSystem.FileSystem>
  /** Sessions' post-open step: the first turn's prompt, once the terminal exists. */
  readonly afterOpen: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    root: string,
    rules: string,
    firstPrompt: string,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path>
  /** The usage-limit move (move.ts), wired in after placement exists. */
  readonly limitMove: Pick<LimitMove, "rerun">
}) => {
  const { db, runtimes, layout, fs, vibest } = deps
  /** Project name on the workspace: the directory's own name, not the key. */
  const projectName = (root: string) =>
    repositoryDirectoryName(root).pipe(
      Effect.catch(() => Effect.flatMap(Path.Path, (p) => Effect.succeed(p.basename(root)))),
    )

  const liveCount = (projectId: number) =>
    db
      .listSessions({ projectId })
      .pipe(Effect.map((rows) => rows.filter((row) => !(row.metadata.archived || row.metadata.removed)).length))

  /** Terminal labels (§3 `present`, [the `label` given to `open`] when absent). A failure here does not fail the session: the terminal is already up. */
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

  /** Undo a step of a launch only when the launch as a whole failed (SPEC §8.2 step 7: reverse order, uninterruptible). */
  const undoOnFailure = <A, E, R, R2>(
    acquire: Effect.Effect<A, E, R>,
    undo: (a: A) => Effect.Effect<unknown, unknown, R2>,
  ) => Effect.acquireRelease(acquire, (a, exit) => (Exit.isFailure(exit) ? undo(a).pipe(Effect.ignore) : Effect.void))

  /** The project's main agent terminal, when it runs in this same runtime (pane ids are the runtime's own). */
  const nearMain = (session: SessionRow, kind: string) =>
    db
      .coordinatorOf(session.projectId)
      .pipe(
        Effect.map((main) =>
          main?.runtime === kind && main.address !== null && main.address.id !== "" ? main.address : undefined,
        ),
      )

  /**
   * The session's terminal (runtime-port.md §3 `open`): running `argv`, kept with the project's other terminals, beside
   * `near` when given. Recorded on the row the moment it exists, so events and checks can find it; closed again by the
   * runtime when its own start inside `open` fails.
   */
  const openTerminal = Effect.fn("Sessions.openTerminal")(function* (
    h: Runtime,
    machine: Machine,
    session: SessionRow,
    input: {
      readonly project: string
      readonly cwd: string
      readonly argv: ReadonlyArray<string>
      /** The project key: its scratch directory is the session's VIBEST_SCRATCH. */
      readonly key: string
      readonly near?: Terminal | undefined
      readonly split?: boolean | undefined
      /** `vibest run --env`: given only to the first terminal, never stored (a later terminal starts without it). */
      readonly env?: Readonly<Record<string, string>> | undefined
      /** A launch ends the process itself (`closeTurn`), once its worktree is undone. */
      readonly endedByCaller?: boolean
    },
  ) {
    // Beside the pane a caller names (--peer), else beside the project's main agent when it runs in this runtime.
    const near = input.near !== undefined ? input.near : yield* nearMain(session, h.kind)
    const choice = {
      harnessId: session.harnessId,
      provider: session.provider,
      model: session.model,
      harnessSessionId: session.harnessSessionId,
    }
    // Its `process.start` before the terminal exists (no terminal yet): what the harness reports while it starts
    // (ready, its pid) belongs to it. One that never opens ends as launch_failed.
    yield* db.updateSession(session.id, { ...choice, address: { machine: session.address.machine, id: "" } })
    const terminal = yield* h
      .open(machine, {
        project: input.project,
        cwd: input.cwd,
        argv: input.argv,
        env: { ...input.env, ...deps.vibestEnv(session, layout.scratch(input.key)) },
        label: `${session.id} ${session.name}`.slice(0, 60),
        ...(near !== undefined ? { near } : {}),
        ...(input.split === true ? { split: true } : {}),
      })
      .pipe(Effect.onError(() => (input.endedByCaller ? Effect.void : db.endProcess(session.id, "launch_failed"))))
    const at = yield* Clock.currentTimeMillis
    // The same process, now in its terminal (`process.start` with it; what it reported while starting carries over).
    yield* db.updateSession(session.id, { ...choice, address: terminal, startedAt: at, exitedAt: null })
    return terminal
  })

  /** `splitFrom` (`vibest run --peer`): the session whose worktree this one shares, and beside whose terminal it opens. */
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

  /** `splitFrom`: the session named by `--peer`, whose terminal the new one opens beside. `env`: `vibest run --env`. */
  const launchRaw = Effect.fn("Sessions.launch")(function* (
    h: Runtime,
    machine: Machine,
    session: SessionRow,
    root: string,
    firstPrompt: string,
    splitFrom?: string,
    env?: Readonly<Record<string, string>>,
  ) {
    const folders = yield* listProjectRepositories(root)
    // The row's own project key: the scratch directory and the rules go to the project the session belongs to.
    const key = yield* db.projectKey(session.projectId)
    if (key === undefined) return yield* Effect.die(`project ${session.projectId} has no key`)
    const peer = splitFrom !== undefined ? yield* peerRow(session, splitFrom) : undefined
    // Beside the peer's pane (openTerminal adds the main agent's when there is no peer).
    const near = peer?.address
    const scratch = layout.scratch(key)
    yield* fs.makeDirectory(scratch, { recursive: true })
    const rules = sessionRules({
      id: session.id,
      peer: splitFrom,
      scratch,
      vibest,
      ...(yield* projectText(layout.project(key))),
    })
    yield* undoOnFailure(writeAtomic(layout.rulesFile(session.id), rules), () =>
      fs.remove(layout.rulesFile(session.id), { force: true }),
    )
    // The same limit-move a failed start always had: it runs inside the scope, so the rules and worktree the move reuses are still there.
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
            .rerun(h, session, undefined, firstPrompt, false, e.message)
            .pipe(Effect.map((): Option.Option<Terminal> => Option.none<Terminal>())),
        ),
        Effect.map((outcome) => (Option.isOption(outcome) ? outcome : Option.some<Terminal>(outcome))),
      )
    // The worktree comes first: the terminal's cwd is in it, the harness argv names it, and the `.worktreeinclude` files are in place before the harness starts.
    const worktree = yield* deps.worktreeOf(session)
    if (peer === undefined) {
      // Spawn reserved the name by creating the directory, empty. A failed start removes it again, unless git left
      // something in it (a refused undo leaves it for `vibest archive`).
      yield* undoOnFailure(Effect.void, () =>
        fs.readDirectory(worktree).pipe(
          Effect.flatMap((left) => (left.length === 0 ? fs.remove(worktree, { recursive: true }) : Effect.void)),
          Effect.ignore,
        ),
      )
      if (folders) {
        // One detached worktree per repository: a plain directory, not one linked worktree of the first.
        yield* undoOnFailure(createIsolatedWorktrees(folders, worktree), () => discardIsolatedWorktrees(worktree))
      } else {
        // Detached, made by vibest: a linked worktree of the main checkout would group away from the project's terminals.
        // Undone with git without force (it deletes ignored files, refuses on anything else); a refusal leaves it for `vibest archive`.
        yield* undoOnFailure(addWorktree(root, worktree), () => git(root, "worktree", "remove", worktree))
      }
    }
    if (!folders) yield* copyIncluded(root, worktree)
    const argv = yield* deps.launchArgv(session, false, key)
    const terminal = yield* openOrMove(
      openTerminal(h, machine, session, {
        project: root,
        cwd: worktree,
        key,
        argv,
        env,
        endedByCaller: true,
        ...(near !== undefined ? { near } : {}),
        ...(peer !== undefined ? { split: true } : {}),
      }),
    )
    if (Option.isNone(terminal)) return
    return yield* deps.afterOpen(h, session, terminal.value, root, rules, firstPrompt)
    // The undos above (worktree, rules, terminal) run when this scope closes: before `launch`'s catch below turns the failure into a notice.
  }, Effect.scoped)
  /** A failed launch closes the row's turn and tells the owner why, with no screen text (its terminal is closed by then). */
  const launch = (
    h: Runtime,
    machine: Machine,
    session: SessionRow,
    root: string,
    firstPrompt: string,
    splitFrom?: string,
    env?: Readonly<Record<string, string>>,
  ) =>
    launchRaw(h, machine, session, root, firstPrompt, splitFrom, env).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const e = Cause.squash(cause)
          const t = yield* Clock.currentTimeMillis
          yield* db.closeTurn(session.id, "failed", {
            status: "unknown",
            exitedAt: t,
            lastActive: t,
            end: "launch_failed",
          })
          yield* deps.notice(
            session,
            `${session.id} failed to start ${session.harnessId}: ${e instanceof Error ? e.message : String(e)}`,
          )
        }),
      ),
    )

  /** The project directory stored on the main agent, if this start wrote one. Never the lookup key. */
  const storedDirectory = (projectId: number) =>
    db.coordinatorOf(projectId).pipe(Effect.map((main) => main?.projectDirectory))

  /**
   * The project's workspace presentation again, after its live count changed (a session ended, was archived or
   * removed): each remaining live session's terminal relabels it, as `republish` does; with none left, the main agent's
   * terminal publishes the workspace alone, without labels of its own. Best-effort: callers ignore failures.
   */
  const recount = Effect.fn("Sessions.recount")(function* (kind: string, projectId: number) {
    const h = yield* runtimes.route(kind).pipe(Effect.option)
    if (Option.isNone(h)) return
    const rows = (yield* db.listSessions({ projectId })).filter(
      (row) => row.runtime === kind && !(row.metadata.archived || row.metadata.removed),
    )
    const stored = yield* storedDirectory(projectId)
    let shown = false
    for (const session of rows) {
      if (session.address.id === "") continue
      yield* show(
        h.value,
        session,
        session.address,
        stored ?? (yield* projectRoot(yield* deps.worktreeOf(session))).root,
      )
      shown = true
    }
    if (shown) return
    // shortcut: without a stored project directory the workspace's project token cannot be named again, so it is left as it is
    const main = yield* db.coordinatorOf(projectId)
    if (main?.runtime !== kind || !main.address || main.address.id === "" || stored === undefined) return
    if (h.value.present === undefined) return
    yield* h.value
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

  /** Where a resumed session is placed, and which project key its rules use: the row's own project, always. */
  const locate = (session: SessionRow) =>
    Effect.gen(function* () {
      const cwd = yield* deps.worktreeOf(session)
      const key = yield* db.projectKey(session.projectId)
      if (key === undefined) return yield* Effect.die(`project ${session.projectId} has no key`)
      const stored = yield* storedDirectory(session.projectId)
      if (yield* listProjectRepositories(cwd)) return { root: stored ?? (yield* projectRoot(cwd)).root, cwd, key }
      return { root: stored ?? (yield* mainCheckout(cwd)), cwd, key }
    })

  const resume = Effect.fn("Sessions.resume")(function* (h: Runtime, session: SessionRow) {
    const machine: Machine = { id: session.address.machine }
    const { root, cwd, key } = yield* locate(session)
    // Today's rules; a conversation that keeps the rules it began with (Cursor) still gets a fresh terminal.
    yield* writeAtomic(
      layout.rulesFile(session.id),
      sessionRules({
        id: session.id,
        // It joined another live session's directory with --peer: that one was there first. The owner keeps its own rules.
        peer: yield* db.earlierSharer(session.id),
        scratch: layout.scratch(key),
        vibest,
        ...(yield* projectText(layout.project(key))),
      }),
    )
    // The terminal is undone when the start fails, like launch: a failed resume must not leave a shell beside the main agent.
    // (openTerminal places it beside the project's main agent, as any start.)
    const terminal = yield* undoOnFailure(
      deps
        .launchArgv(session, true, key)
        .pipe(Effect.flatMap((argv) => openTerminal(h, machine, session, { project: root, cwd, key, argv }))),
      (terminal) => h.close(terminal).pipe(Effect.ignore),
    )
    yield* show(h, session, terminal, root)
  }, Effect.scoped)

  /** The runtime drops terminal metadata on restart. Put back what the live sessions still are. */
  const republish = Effect.fn("Sessions.republish")(function* () {
    const rows = (yield* db.listSessions()).filter(
      (row) => !(row.metadata.archived || row.metadata.removed) && row.address.id !== "",
    )
    const labelled = yield* Effect.forEach(rows, (session) =>
      Effect.gen(function* () {
        const h = yield* runtimes.route(session.runtime).pipe(Effect.option)
        if (Option.isNone(h)) return 0
        const stored = yield* storedDirectory(session.projectId)
        const root = stored ?? (yield* projectRoot(yield* deps.worktreeOf(session))).root
        yield* show(h.value, session, session.address, root)
        return 1
      }).pipe(Effect.orElseSucceed(() => 0)),
    )
    return labelled.reduce((sum, n) => sum + n, 0)
  })

  return { launch, resume, republish, recount, openTerminal, show, locate }
}
