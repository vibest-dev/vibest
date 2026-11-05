import { RemoveOutcome } from "@vibest/schema/remove"
import { RuntimeUnreachable } from "@vibest/schema/session"
// What `vibest archive` (alias `rm`) does once a session is marked archived (SPEC §8.6a): close its terminal — the
// runtime's own close, which sees its processes off (runtime-port.md §3) — then remove its worktree only when nothing
// can be lost. Sessions.remove holds the session's lock and does everything before. Every fact that guards a
// destructive step is asked right before that step, never reused from earlier.
import { Clock, Duration, Effect, FileSystem, Option } from "effect"

import { awaitOn, Bus } from "./bus.ts"
import { Db, type SessionRow } from "./db.ts"
import { Layout } from "./paths.ts"
import { Processes, validPid } from "./processes.ts"
import { listProjectRepositories, workspaceGit } from "./project-create.ts"
import { agentState, type Runtime, type Terminal } from "./runtimes.ts"
import { removeSystemPrompt } from "./system-prompt.ts"
import { git, gitState, mainCheckout } from "./worktree.ts"
export { RemoveOutcome } from "@vibest/schema/remove"

type ProcessState = RemoveOutcome["processes"]

/** Once the terminal closed: how long the one listing of processes working in the worktree may take. */
export const CWD_WAIT = Duration.seconds(10)

/** How long a stopped main agent's harness has to exit after SIGTERM. */
export const HARNESS_EXIT_WAIT = Duration.seconds(10)

/**
 * End a main agent's harness so that it can start in another terminal (the RPC `Project.StopCoordinator`): SIGTERM to
 * that one PID, never its process group or its terminal, so the terminal and its shell stay. `pid` is what its own
 * `vibest` reported before it exec'd the harness. The row first leaves its place (`detach`), so the harness's exit drops
 * nothing; a harness still there after `wait` is not stopped, and the row goes back (`reattach`). Signalled only while
 * the runtime sees an agent in that terminal; an exited PID means it is already gone. `moved`: the row was no longer at
 * that place. `unsupported` (with why): nothing vibest can signal from here (another machine, no PID recorded, or no agent
 * seen there while the PID is alive, so it may be another program now).
 *
 * ponytail: local machine only (a PID names a process on vibestd's machine); a remote machine needs a runtime operation.
 * A PID reused by another program while the runtime still sees an agent there would get the signal.
 */
export const stopAgent = (
  h: Runtime,
  terminal: Terminal,
  input: {
    readonly pid: number | undefined
    readonly detach: Effect.Effect<boolean>
    readonly reattach: Effect.Effect<void>
    readonly wait: Duration.Duration
  },
) =>
  Effect.gen(function* () {
    const processes = yield* Processes
    const pid = input.pid
    const unsupported = (reason: string) => ({ result: "unsupported" as const, reason })
    if (terminal.machine !== "local")
      return unsupported("it runs on another machine, and vibest stops a main agent only on its own machine")
    if (pid === undefined || !validPid(pid))
      return unsupported("it was started by an older vibest, which recorded no process to stop")
    const detached = Effect.map(input.detach, (ok) => ({ result: ok ? ("stopped" as const) : ("moved" as const) }))
    if ((yield* processes.liveness(pid)) === "exited") return yield* detached
    const seen = yield* agentState(h, terminal).pipe(Effect.orElseSucceed(() => "unknown" as const))
    if (seen === "absent" || seen === "unknown")
      return unsupported("vibest does not see its harness in that terminal, so its process may be another program now")
    // From detach to the answer, uninterruptible (at most `wait`): an interrupt in between (the CLI's Ctrl-C ends its
    // request) would leave the row detached while the harness still runs, and another terminal could start a second one.
    return yield* Effect.uninterruptible(
      Effect.scoped(
        Effect.gen(function* () {
          if ((yield* detached).result === "moved") return { result: "moved" as const }
          // Gone once its pid exited or the runtime reports its terminal's program exited; at `wait`, one last look at
          // the pid (a harness the runtime never saw as an agent exits without an event).
          const gone = processes.liveness(pid).pipe(Effect.map((l) => l === "exited"))
          // Subscribed before the signal, so an exit it causes cannot come before the wait.
          const subscription = yield* (yield* Bus).subscribe
          const exited =
            (yield* processes.terminate(pid)) === "sent" &&
            (yield* awaitOn(
              subscription,
              gone.pipe(Effect.map((yes) => (yes ? Option.some(true) : Option.none()))),
              (event) =>
                Effect.succeed(
                  event.type === "live.exited" &&
                    event.terminal.machine === terminal.machine &&
                    event.terminal.id === terminal.id
                    ? Option.some(true)
                    : Option.none(),
                ),
              input.wait,
              gone,
            ))
          if (exited) return { result: "stopped" as const }
          yield* input.reattach
          return { result: "running" as const }
        }),
      ),
    )
  })

export interface ReleaseInput {
  readonly h: Runtime
  /** The row, already marked archived (and removed, for older readers). */
  readonly session: SessionRow
  /** The terminal the runtime had the agent in when `vibest archive` began, if any. */
  readonly terminal: Terminal | undefined
  readonly keepWorktree: boolean | undefined
  /** Reasons gathered so far; the outcome's reasons continue them. */
  readonly reasons: ReadonlyArray<string>
}

export const make = Effect.gen(function* () {
  const db = yield* Db
  const layout = yield* Layout
  const processes = yield* Processes

  /**
   * Close the session's terminal (the runtime's close sees its processes off), then remove its worktree only when
   * nothing can be lost: no process still has its working directory there, and git would lose nothing it tracks (no
   * changes, no untracked files, HEAD on a branch; ignored files go with the worktree, as git removes them). Its branch
   * is never deleted. Safe to repeat: a kept worktree is tried again, a missing one reconciled.
   */
  const release = (input: ReleaseInput) =>
    Effect.gen(function* () {
      const { h, session } = input
      const id = session.id
      const fs = yield* FileSystem.FileSystem
      const reasons = [...input.reasons]
      const directory = yield* db.sessionDirectory(id)
      // No directory recorded: do not guess one, and do not close a terminal by a guessed checkout.
      if (!directory) {
        reasons.push(`${id} records no directory; nothing was deleted`)
        return {
          id,
          processes: "unknown" as const,
          pane: "none" as const,
          workspace: "none" as const,
          worktree: "kept" as const,
          path: "",
          branch: null,
          reasons,
        }
      }
      const worktree = directory
      const exists = worktree !== "" && (yield* fs.exists(worktree))
      const real = exists ? yield* fs.realPath(worktree) : worktree

      /** The terminal step: the runtime closes it (its processes signalled with it); already-gone is `closed`. */
      const closeTerminal = () =>
        Effect.gen(function* () {
          // A legacy row names a runtime session without its pane (migrated to id "" before this runs): nothing of its own to close.
          if (input.terminal === undefined || input.terminal.id === "") return "none" as const
          // A lost reply or a vibestd restart still has the terminal on the row to retry.
          const outcome = yield* h.close(input.terminal).pipe(
            Effect.as("closed" as const),
            Effect.catchTag("RuntimeError", (error) =>
              // Only the connection breaking reaches the caller: the close may have happened, and only the retry learns.
              error.code === "unreachable"
                ? Effect.fail(
                    new RuntimeUnreachable({
                      session: session.runtime,
                      message: `closing terminal ${input.terminal!.id}: ${error.message}`,
                    }),
                  )
                : Effect.succeed(error.code === "not_found" ? ("closed" as const) : ("kept" as const)),
            ),
          )
          if (outcome === "kept") {
            // The runtime refused: nothing proven.
            reasons.push(`closing terminal ${input.terminal.id} failed; its processes are not confirmed gone`)
            return "kept" as const
          }
          // shortcut: the runtime's close disposes the terminal's processes by contract; vibestd still proves it by cwd before the worktree goes
          return "closed" as const
        })

      /**
       * Whether the worktree's processes are gone, once the terminal closed: no process of this user has its working
       * directory in it. One listing, bounded by CWD_WAIT (lsof can take a second); one cut off there is ended and
       * reaped and never counts as an empty listing. A holder found keeps the worktree, and the reason names it.
       */
      const confirmExited = Effect.gen(function* () {
        const asked = yield* processes.cwdUsers([real, worktree]).pipe(Effect.timeoutOption(CWD_WAIT))
        const users = Option.getOrUndefined(asked)
        if (users === undefined)
          return {
            state: "unknown" as const,
            why: Option.isNone(asked)
              ? `vibest could not finish listing this user's processes working in it within ${Duration.format(CWD_WAIT)}`
              : "vibest could not get a complete list of this user's processes working in it (lsof missing, failed, warned or timed out)",
          }
        if (users.length > 0)
          return { state: "alive" as const, why: `process ${users.join(", ")} has its working directory in it` }
        return { state: "exited" as const, why: "" }
      })

      const pane = yield* closeTerminal()
      // A close that failed proves nothing about the processes (the runtime never said it closed them).
      const confirmed =
        pane === "kept"
          ? { state: "unknown" as const, why: "its terminal was not closed, so nothing is proven" }
          : yield* confirmExited
      const processState: ProcessState = confirmed.state
      // Its process ends with the archive (`process.end` reason archived) once nothing of it is left.
      if (processState === "exited" && session.exitedAt === null) {
        const t = yield* Clock.currentTimeMillis
        yield* db.updateSession(id, { status: "unknown", exitedAt: t, lastActive: t, end: "archived" })
      }
      /** The directory stays because another live session works in it. */
      let shared = false
      const g = exists ? yield* gitState(worktree) : undefined
      const multiGit = exists ? yield* workspaceGit(worktree).pipe(Effect.orDie) : undefined
      const root = exists
        ? yield* mainCheckout(worktree).pipe(Effect.option, Effect.map(Option.getOrUndefined))
        : undefined
      /** A linked worktree of `repoRoot` (porcelain; the main checkout's own line does not count). */
      const linked = (repoRoot: string, path: string) =>
        Effect.gen(function* () {
          const at = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => path))
          const lines = (yield* git(repoRoot, "worktree", "list", "--porcelain").pipe(
            Effect.orElseSucceed(() => ""),
          )).split("\n")
          return lines
            .filter((line) => line.startsWith("worktree "))
            .slice(1)
            .includes(`worktree ${at}`)
        })
      /** Why the worktree stays, checked in this order and only as far as needed; undefined once git removed it. */
      const keepWorktree = Effect.gen(function* () {
        if (input.keepWorktree) return "worktree kept as asked (--keep-worktree)"
        // Only a directory vibest made: one under its worktrees root.
        if (!worktree.startsWith(layout.worktrees + "/"))
          return `${worktree} is not under ${layout.worktrees}; left alone`
        const sharing = (live: ReadonlyArray<string>) =>
          live.length > 0 ? `worktree kept: session ${live.join(", ")} still works in it` : undefined
        const liveSharers = db.liveSharers(id)
        const early = sharing(yield* liveSharers)
        if (early) {
          shared = true
          return early
        }
        // Re-read git and sharers immediately before `worktree remove`. Undefined: removed.
        /** Removed: undefined. A live sharer stops the whole removal; any other keep stays on this worktree. */
        const removeLinked = (repoRoot: string, path: string) =>
          Effect.gen(function* () {
            const state = yield* gitState(path)
            if (!state?.saved) return { stop: false, reason: `worktree kept: ${state?.why ?? "git cannot read it"}` }
            const again = sharing(yield* liveSharers)
            if (again) {
              shared = true
              return { stop: true, reason: again }
            }
            const refused = yield* git(repoRoot, "worktree", "remove", path).pipe(
              Effect.as(undefined),
              Effect.catchTag("GitError", (e) => Effect.succeed(e.message)),
            )
            return refused === undefined ? undefined : { stop: false, reason: `worktree kept: git refused: ${refused}` }
          })
        // Another terminal still works there: its shell keeps the worktree. (The runtime API has no terminal listing;
        // `confirmExited` above — no process of this user with its cwd there — is the check that covers this now.)
        // A multi-repository workspace is not itself a worktree: the same removal per repository, then the directory if empty.
        const isLinked = root !== undefined && (yield* linked(root, worktree))
        const children = isLinked ? undefined : yield* listProjectRepositories(worktree).pipe(Effect.orDie)
        if (!isLinked && !children) return `${worktree} is not a worktree of its repository; left alone`
        if (processState !== "exited") return `worktree kept: ${confirmed.why}`
        if (children) {
          const notes: string[] = []
          for (const child of children) {
            const repoRoot = yield* mainCheckout(child.path).pipe(Effect.option, Effect.map(Option.getOrUndefined))
            if (repoRoot === undefined || !(yield* linked(repoRoot, child.path))) {
              notes.push(`${child.name}: ${child.path} is not a worktree of its repository; left alone`)
              continue
            }
            const kept = yield* removeLinked(repoRoot, child.path)
            if (kept === undefined) continue
            if (kept.stop) return [kept.reason, ...notes].join("; ")
            notes.push(`${child.name}: ${kept.reason}`)
          }
          if (notes.length > 0) return notes.join("; ")
          const left = yield* fs.readDirectory(worktree).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
          if (left.length === 0) yield* fs.remove(worktree, { recursive: true }).pipe(Effect.ignore)
          return undefined
        }
        if (root === undefined) return `${worktree} is not a worktree of its repository; left alone`
        return (yield* removeLinked(root, worktree))?.reason
      })
      let tree: "removed" | "kept" | "gone" = "gone"
      if (!exists) reasons.push(`${worktree} was already gone`)
      else {
        const kept = yield* keepWorktree
        tree = kept === undefined ? "removed" : "kept"
        if (kept !== undefined) reasons.push(kept)
      }
      // Processes that may still be running may still read its system prompt or report a turn end. Its files are its
      // own even though a directory another session works in stays.
      if ((tree !== "kept" || shared) && processState === "exited") {
        yield* removeSystemPrompt(id)
      }
      const branch = multiGit
        ? multiGit
            .map((r) => (r.branch ? `${r.name}=${r.branch}` : ""))
            .filter(Boolean)
            .join("\n") || null
        : g?.branch || null
      return {
        id,
        processes: processState,
        pane,
        workspace: "none" as const,
        worktree: tree,
        path: worktree,
        branch,
        reasons,
      }
    })

  return { release }
})
