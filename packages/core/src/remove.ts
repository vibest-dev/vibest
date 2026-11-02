import { RemoveOutcome } from "@vibest/schema/remove"
import { RuntimeUnreachable } from "@vibest/schema/session"
// What `vibest archive` (alias `rm`) does once a session is marked archived (SPEC §8.6a): close its terminal — the
// runtime's own close, which sees its processes off (runtime-port.md §3) — then remove its worktree only when nothing
// can be lost. Sessions.remove holds the session's lock and does everything before. Every fact that guards a
// destructive step is asked right before that step, never reused from earlier.
import { Clock, Duration, Effect, FileSystem, Option, Schedule } from "effect"

import { Db, type SessionRow } from "./db.ts"
import { Layout, resolveWorktree } from "./paths.ts"
import { Processes } from "./processes.ts"
import { listProjectRepositories, workspaceGit } from "./project-create.ts"
import { alive, type Runtime, type Terminal } from "./runtimes.ts"
import { git, gitState, mainCheckout } from "./worktree.ts"
export { RemoveOutcome } from "@vibest/schema/remove"

type StopRecord = NonNullable<SessionRow["metadata"]["stop"]>[number]
type ProcessState = RemoveOutcome["processes"]

/** Once the terminal closed: how long between cwd listings while one still names a process, and how long in all. */
export const CWD_POLL = Duration.millis(500)
export const CWD_WAIT = Duration.seconds(10)

/**
 * Stop the agent a coordinator's terminal runs, without closing it (the RPC `Project.StopCoordinator`): the harness's
 * interrupt key, then until it is no longer working. `moved`: the row was no longer the one asked about. `running`: it
 * did not settle. The write transaction the old signal needed is gone with the signal: `stillThere` is asked again
 * after the wait.
 */
export const stopAgent = (
  h: Runtime,
  terminal: Terminal,
  input: {
    readonly interruptKey: string
    readonly stillThere: Effect.Effect<boolean>
    readonly wait: Duration.Duration
  },
) =>
  Effect.gen(function* () {
    if (!(yield* input.stillThere)) return "moved" as const
    yield* h.send(terminal, { keys: [input.interruptKey] }).pipe(Effect.ignore)
    // No `state` member: the terminal's own program decides (§5's `process` fallback).
    const settled: Effect.Effect<boolean> =
      h.state === undefined
        ? alive(h, terminal).pipe(Effect.map((running) => !running))
        : h.state(terminal).pipe(
            Effect.option,
            Effect.map(Option.map((state) => state !== "working" && state !== "blocked")),
            Effect.map((idle) => Option.getOrElse(idle, () => false)),
          )
    const stopped = yield* settled.pipe(
      Effect.repeat({ until: (idle) => idle, schedule: Schedule.spaced("500 millis") }),
      Effect.timeoutOrElse({ duration: input.wait, orElse: () => Effect.succeed(false) }),
    )
    if (!(yield* input.stillThere)) return "moved" as const
    return stopped ? ("stopped" as const) : ("running" as const)
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
      // A row from before `vibest run --access` was removed may be a read session: it worked in the project directory and owns no worktree.
      const read = session.metadata.access === "read"
      const located = read ? undefined : yield* resolveWorktree(layout, session, (ownerId) => db.getSession(ownerId))
      // No safe directory: do not join a second path, and do not close a terminal by a guessed checkout.
      if (located !== undefined && located._tag === "Unresolved") {
        reasons.push(located.message)
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
      const worktree = located?.path ?? ""
      const exists = worktree !== "" && (yield* fs.exists(worktree))
      const real = exists ? yield* fs.realPath(worktree) : worktree

      const before = session.metadata.stop ?? []
      /** The row's metadata with `stop` set to `records` (none: no key, exactly as before any record). */
      const withStop = (records: ReadonlyArray<StopRecord>) => {
        const { stop: _, ...rest } = session.metadata
        return records.length > 0 ? { ...rest, stop: records } : rest
      }

      /** The terminal step: the runtime closes it (its processes signalled with it); already-gone is `closed`. */
      const closeTerminal = () =>
        Effect.gen(function* () {
          // A legacy row names a runtime session without its pane (migrated to id "" before this runs): nothing of its own to close.
          if (input.terminal === undefined || input.terminal.id === "")
            return { pane: "none" as const, records: before }
          // Named before the close, proven nothing yet: a lost reply or a vibestd restart still has the terminal to retry.
          const unproven = [
            ...before.filter((r) => r.pane !== input.terminal!.id),
            { pane: input.terminal.id, pids: [] as ReadonlyArray<number>, exited: false },
          ]
          yield* db.updateSession(id, { metadata: withStop(unproven) })
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
            // The runtime refused: nothing proven, and the pre-written record is not evidence of anything.
            yield* db.updateSession(id, { metadata: withStop(before) })
            reasons.push(`closing terminal ${input.terminal.id} failed; its processes are not confirmed gone`)
            return { pane: "kept" as const, records: before }
          }
          // shortcut: the runtime's close disposes the terminal's processes by contract; vibestd still proves it by cwd before the worktree goes
          const records = [
            ...before.filter((r) => r.pane !== input.terminal!.id),
            { pane: input.terminal.id, pids: [] as ReadonlyArray<number>, exited: true },
          ]
          return { pane: "closed" as const, records }
        })

      /**
       * Whether the worktree's processes are gone, once the terminal closed: no process of this user still has its
       * working directory in it. A detached helper (an MCP server's telemetry watchdog) may still be shutting down, so
       * a holder is asked about again for a while. CWD_WAIT bounds the listings themselves too (lsof can take a second
       * each); one cut off there has its lsof ended and reaped before this goes on, and never counts as an empty listing.
       */
      const confirmExited = Effect.gen(function* () {
        let last: ReadonlyArray<number> | undefined
        // The wait bounds the listings themselves too (lsof can take a second each): one cut off at the deadline is
        // interrupted and reaped, never read as an answer.
        const asked = yield* processes.cwdUsers([real, worktree]).pipe(
          Effect.tap((u) => Effect.sync(() => (last = u))),
          Effect.repeat({ while: (u) => u !== undefined && u.length > 0, schedule: Schedule.spaced(CWD_POLL) }),
          Effect.timeoutOption(CWD_WAIT),
        )
        if (Option.isNone(asked))
          return last && last.length > 0
            ? {
                state: "alive" as const,
                why: `process ${last.join(", ")} still had its working directory in it after ${Duration.format(CWD_WAIT)}`,
              }
            : {
                state: "unknown" as const,
                why: `vibest could not finish listing this user's processes working in it within ${Duration.format(CWD_WAIT)}`,
              }
        const users = asked.value
        if (users === undefined)
          return {
            state: "unknown" as const,
            why: "vibest could not get a complete list of this user's processes working in it (lsof missing, failed, warned or timed out)",
          }
        if (users.length > 0)
          return { state: "alive" as const, why: `process ${users.join(", ")} has its working directory in it` }
        return { state: "exited" as const, why: "" }
      })

      const { pane, records } = yield* closeTerminal()
      // A close that failed proves nothing about the processes (the runtime never said it closed them).
      const confirmed =
        pane === "kept"
          ? { state: "unknown" as const, why: "its terminal was not closed, so nothing is proven" }
          : yield* confirmExited
      const processState: ProcessState = confirmed.state
      if (pane === "closed" && records !== before) yield* db.updateSession(id, { metadata: withStop(records) })
      if (processState === "exited" && session.exitedAt === null) {
        const t = yield* Clock.currentTimeMillis
        yield* db.updateSession(id, { status: "unknown", exitedAt: t, lastActive: t })
      }
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
        if (session.metadata.peer)
          return `worktree kept: it is ${session.metadata.peer}'s (vibest run --peer); vibest archive ${session.metadata.peer} removes it`
        const liveBorrowers = db
          .listSessions({ stopped: true })
          .pipe(
            Effect.map((rows) =>
              rows.filter(
                (s) => s.metadata.peer === id && !s.metadata.archived && !s.metadata.removed && s.exitedAt === null,
              ),
            ),
          )
        const sharing = (live: ReadonlyArray<{ readonly id: string }>) =>
          live.length > 0
            ? `worktree kept: session ${live.map((s) => s.id).join(", ")} still shares it (vibest run --peer)`
            : undefined
        const early = sharing(yield* liveBorrowers)
        if (early) return early
        // Re-read git and borrowers immediately before `worktree remove`. Undefined: removed.
        /** Removed: undefined. A borrower stops the whole removal; any other keep stays on this worktree. */
        const removeLinked = (repoRoot: string, path: string) =>
          Effect.gen(function* () {
            const state = yield* gitState(path)
            if (!state?.saved) return { stop: false, reason: `worktree kept: ${state?.why ?? "git cannot read it"}` }
            const again = sharing(yield* liveBorrowers)
            if (again) return { stop: true, reason: again }
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
      if (read) {
        // No worktree path: the terminal was closed above, and git worktree remove is not run.
      } else if (!exists) reasons.push(`${worktree} was already gone`)
      else {
        const kept = yield* keepWorktree
        tree = kept === undefined ? "removed" : "kept"
        if (kept !== undefined) reasons.push(kept)
      }
      // Processes that may still be running may still read its rules or write its result. A borrower's files are its own even though the shared worktree stays.
      if ((tree !== "kept" || session.metadata.peer) && processState === "exited") {
        yield* fs.remove(layout.resultFile(id), { force: true })
        yield* fs.remove(layout.rulesFile(id), { force: true })
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
