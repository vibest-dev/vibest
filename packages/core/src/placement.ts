import { NoSuchSession, NotReady } from "@vibest/schema/session"
// Where a session's terminal goes, and the labels the runtime shows on it. `root` is a project directory, never the
// project key. Placement is the runtime's (runtime-port.md §3): core asks for a terminal running the harness argv,
// kept beside the project's other terminals (`near`), and labels it with `present` when the runtime has one.
import {
  Cause,
  Clock,
  type Config,
  Context,
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

import type { HarnessUnavailable } from "./harness.ts"
import type { LimitMove } from "./move.ts"
import { isUsageLimitError } from "./results.ts"
import { type Machine, type RuntimesShape, type Runtime, type Terminal } from "./runtimes.ts"
import { RuntimeError } from "./runtimes.ts"
import type { EndReason, SessionPatch, SessionRow } from "./storage.ts"
import { removeSystemPrompt, type SystemPromptDirUnsafe } from "./system-prompt.ts"
import type { GitError, NotInRepository, WorkspaceShape } from "./workspace.ts"

type Labels = Readonly<Record<string, string>>

/**
 * The product's terminal placement policy (@vibest/vibest/placement): which terminal a new one opens beside, which
 * directory a session's terminals belong to, and what a scope's terminals show together. The engine opens, labels and
 * closes terminals; it asks here where and what.
 */
export interface PlacementPolicyShape {
  /** The terminal a new one of `session` opens beside in runtime `kind` when no caller named one, or none. */
  readonly near: (session: SessionRow, kind: string) => Effect.Effect<Terminal | undefined>
  /** The directory a resumed or moved session at `cwd` is placed in (the runtime groups terminals by it). */
  readonly root: (
    session: SessionRow,
    cwd: string,
  ) => Effect.Effect<string, NotInRepository | GitError | PlatformError.PlatformError>
  /** The directory a live session's terminal is labelled for again. */
  readonly labelRoot: (
    session: SessionRow,
    cwd: string,
  ) => Effect.Effect<string, NotInRepository | PlatformError.PlatformError>
  /** The scope's labels on a terminal of a session of `scope` placed at `root`. */
  readonly labels: (scope: string, root: string) => Effect.Effect<Labels>
  /** No live session of `scope` is labelled in runtime `kind` (`live` of them still are): the terminal that shows the scope alone, and its labels. */
  readonly alone: (
    scope: string,
    kind: string,
    live: number,
  ) => Effect.Effect<{ readonly terminal: Terminal; readonly labels: Labels } | undefined>
}

export class PlacementPolicy extends Context.Service<PlacementPolicy, PlacementPolicyShape>()(
  "vibest/PlacementPolicy",
) {}

/** The harness dying on its own usage limit inside `open` (§3): the launch hands over to the limit move, as a failed start did. */
class AgentOwnLimit extends Data.TaggedError("AgentOwnLimit")<{ readonly message: string }> {}

export const sessionPlacement = (deps: {
  readonly db: {
    readonly listSessions: (filter?: { readonly scope?: string }) => Effect.Effect<ReadonlyArray<SessionRow>>
    readonly closeTurn: (id: string, end: "failed", patch: SessionPatch) => Effect.Effect<void>
    /** The row of `--peer`'s named session. */
    readonly getSession: (id: string) => Effect.Effect<SessionRow | undefined>
    readonly updateSession: (id: string, patch: SessionPatch) => Effect.Effect<void>
    readonly endProcess: (id: string, reason: EndReason) => Effect.Effect<boolean>
  }
  /** The registry every row's `runtime.kind` routes through. */
  readonly runtimes: RuntimesShape
  readonly workspace: WorkspaceShape
  readonly policy: PlacementPolicyShape
  readonly path: { readonly dirname: (path: string) => string }
  readonly harnesses: { readonly get: (id: SessionRow["harnessId"]) => { readonly systemPromptInPrompt: boolean } }
  readonly worktreeOf: (session: SessionRow) => Effect.Effect<string, NoSuchSession>
  /** vibest's variables in the session's terminal; `files`: the workspace's for its shared files directory. */
  readonly vibestEnv: (session: SessionRow, files: Readonly<Record<string, string>>) => Readonly<Record<string, string>>
  /** The harness argv a terminal runs (sessions.ts `launchArgv`). */
  readonly launchArgv: (
    session: SessionRow,
    resume: boolean,
    key: string,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    HarnessUnavailable | NoSuchSession | PlatformError.PlatformError | SystemPromptDirUnsafe | Config.ConfigError
  >
  readonly notice: (session: SessionRow, kind: "not_started", message: string) => Effect.Effect<unknown>
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
    /** The row's project key: Cursor's system prompt goes in front of the first prompt. */
    key: string,
    firstPrompt: string,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path>
  /** The usage-limit move (move.ts), wired in after placement exists. */
  readonly limitMove: Pick<LimitMove, "rerun">
}) => {
  const { db, runtimes, workspace, policy } = deps

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
        ...(yield* policy.labels(session.scope, root)),
      })
    }).pipe(Effect.ignore)

  /** Undo a step of a launch only when the launch as a whole failed (SPEC §8.2 step 7: reverse order, uninterruptible). */
  const undoOnFailure = <A, E, R, R2>(
    acquire: Effect.Effect<A, E, R>,
    undo: (a: A) => Effect.Effect<unknown, unknown, R2>,
  ) => Effect.acquireRelease(acquire, (a, exit) => (Exit.isFailure(exit) ? undo(a).pipe(Effect.ignore) : Effect.void))

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
      /** The session's grouping key: the workspace's shared files directory for it goes in the environment. */
      readonly key: string
      readonly near?: Terminal | undefined
      readonly split?: boolean | undefined
      /** `vibest run --env`: given only to the first terminal, never stored (a later terminal starts without it). */
      readonly env?: Readonly<Record<string, string>> | undefined
      /** A launch ends the process itself (`closeTurn`), once its worktree is undone. */
      readonly endedByCaller?: boolean
    },
  ) {
    // Beside the pane a caller names (--peer), else where the policy puts it.
    const near = input.near !== undefined ? input.near : yield* policy.near(session, h.kind)
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
        env: { ...input.env, ...deps.vibestEnv(session, (yield* workspace.files(input.key)).env) },
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
    // The row's own grouping key: its shared files and system prompt are its group's.
    const key = session.scope
    const peer = splitFrom !== undefined ? yield* peerRow(session, splitFrom) : undefined
    // Beside the peer's pane (openTerminal adds the main agent's when there is no peer).
    const near = peer?.address
    // The same limit-move a failed start always had: it runs inside the scope, so the worktree the move reuses is still there.
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
    yield* workspace.prepare(root, worktree, peer !== undefined)
    // The system prompt launchArgv writes goes again when the start fails.
    yield* undoOnFailure(Effect.void, () => removeSystemPrompt(session.id))
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
    return yield* deps.afterOpen(h, session, terminal.value, root, key, firstPrompt)
    // The undos above (worktree, terminal) run when this scope closes: before `launch`'s catch below turns the failure into a notice.
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
            "not_started",
            `${session.id} failed to start ${session.harnessId}: ${e instanceof Error ? e.message : String(e)}`,
          )
        }),
      ),
    )

  /**
   * The project's workspace presentation again, after its live count changed (a session ended, was archived or
   * removed): each remaining live session's terminal relabels it, as `republish` does; with none left, the main agent's
   * terminal publishes the workspace alone, without labels of its own. Best-effort: callers ignore failures.
   */
  const recount = Effect.fn("Sessions.recount")(function* (kind: string, scope: string) {
    const h = yield* runtimes.route(kind).pipe(Effect.option)
    if (Option.isNone(h)) return
    const rows = (yield* db.listSessions({ scope })).filter(
      (row) => row.runtime === kind && !(row.metadata.archived || row.metadata.removed),
    )
    let shown = false
    for (const session of rows) {
      if (session.address.id === "") continue
      yield* show(h.value, session, session.address, yield* policy.labelRoot(session, yield* deps.worktreeOf(session)))
      shown = true
    }
    if (shown) return
    if (h.value.present === undefined) return
    const alone = yield* policy.alone(scope, kind, rows.length)
    if (alone === undefined) return
    yield* h.value
      .present(alone.terminal, { agent: "", harness: "", title: "", definition: "", session: "", ...alone.labels })
      .pipe(Effect.ignore)
  })

  /** Where a resumed session is placed, and which project key its system prompt uses: the row's own project, always. */
  const locate = (session: SessionRow) =>
    Effect.gen(function* () {
      const cwd = yield* deps.worktreeOf(session)
      const key = session.scope
      return { root: yield* policy.root(session, cwd), cwd, key }
    })

  const resume = Effect.fn("Sessions.resume")(function* (h: Runtime, session: SessionRow) {
    const machine: Machine = { id: session.address.machine }
    const { root, cwd, key } = yield* locate(session)
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
        const root = yield* policy.labelRoot(session, yield* deps.worktreeOf(session))
        yield* show(h.value, session, session.address, root)
        return 1
      }).pipe(Effect.orElseSucceed(() => 0)),
    )
    return labelled.reduce((sum, n) => sum + n, 0)
  })

  return { launch, resume, republish, recount, openTerminal, show, locate }
}
