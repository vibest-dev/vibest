import { Layout } from "@vibest/schema/layout"
import { RemoveOutcome } from "@vibest/schema/remove"
import { RuntimeUnreachable } from "@vibest/schema/session"
import { Clock, Duration, Effect, FileSystem, Option, Path } from "effect"

import { awaitOn, Bus } from "./bus.ts"
import { type SessionRow, runtimeOf, terminalOf, exitedAt } from "./database/db-rows.ts"
import { Db } from "./database/db.ts"
import { Git } from "./git.ts"
import { Processes, validPid } from "./processes.ts"
import { listProjectRepositories, workspaceGit } from "./project/create.ts"
import { agentState, type Runtime, type Terminal } from "./runtimes.ts"
import { removeSystemPrompt } from "./system-prompt.ts"
import { gitState, mainCheckout, removeWorktree } from "./worktree.ts"

type ProcessState = RemoveOutcome["processes"]

export const CWD_WAIT = Duration.seconds(10)

export const HARNESS_EXIT_WAIT = Duration.seconds(10)

export const TREE_EXIT_WAIT = Duration.seconds(10)

const TREE_EXIT_POLL = Duration.millis(100)

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
    const processes = yield* Processes.Service
    const pid = input.pid
    const unsupported = (reason: string) => ({ result: "unsupported" as const, reason })
    if (pid === undefined || !validPid(pid))
      return unsupported("it was started by an older vibest, which recorded no process to stop")
    const detached = Effect.map(input.detach, (ok) => ({ result: ok ? ("stopped" as const) : ("moved" as const) }))
    if ((yield* processes.liveness(pid)) === "exited") return yield* detached
    const seen = yield* agentState(h, terminal).pipe(Effect.orElseSucceed(() => "unknown" as const))
    if (seen === "absent" || seen === "unknown")
      return unsupported("vibest does not see its harness in that terminal, so its process may be another program now")
    return yield* Effect.uninterruptible(
      Effect.scoped(
        Effect.gen(function* () {
          if ((yield* detached).result === "moved") return { result: "moved" as const }
          const gone = processes.liveness(pid).pipe(Effect.map((l) => l === "exited"))
          const subscription = yield* (yield* Bus.Service).subscribe()
          const exited =
            (yield* processes.terminate(pid)) === "sent" &&
            (yield* awaitOn(
              subscription,
              gone.pipe(Effect.map((yes) => (yes ? Option.some(true) : Option.none()))),
              (event) =>
                Effect.succeed(
                  event.type === "terminal.exited" &&
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
  readonly session: SessionRow
  readonly terminal: Terminal | undefined
  readonly keepWorktree: boolean | undefined
  readonly reasons: ReadonlyArray<string>
}

export const make = Effect.gen(function* () {
  const db = yield* Db
  const layout = yield* Layout
  const processes = yield* Processes.Service
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const git = yield* Git.Service

  const release = (input: ReleaseInput) =>
    Effect.gen(function* () {
      const { h, session } = input
      const id = session.id
      const reasons = [...input.reasons]
      const directory = yield* db.session.sessionDirectory(id)
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

      const closeTerminal = () =>
        Effect.gen(function* () {
          if (input.terminal === undefined || input.terminal.id === "") return "none" as const
          const outcome = yield* h.close(input.terminal).pipe(
            Effect.as("closed" as const),
            Effect.catchTag("RuntimeError", (error) =>
              error.code === "unreachable"
                ? Effect.fail(
                    new RuntimeUnreachable({
                      session: runtimeOf(session),
                      message: `closing terminal ${input.terminal!.id}: ${error.message}`,
                    }),
                  )
                : Effect.succeed(error.code === "not_found" ? ("closed" as const) : ("kept" as const)),
            ),
          )
          if (outcome === "kept") {
            reasons.push(`closing terminal ${input.terminal.id} failed; its processes are not confirmed gone`)
            return "kept" as const
          }
          return "closed" as const
        })

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

      const harnessPid = session.process?.pid
      const owned =
        terminalOf(session).machine === "local" && validPid(harnessPid) ? yield* processes.tree(harnessPid) : undefined
      const pane = yield* closeTerminal()
      if (pane !== "kept" && owned !== undefined) {
        const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(TREE_EXIT_WAIT)
        for (;;) {
          const alive: Array<number> = []
          for (const pid of owned) if ((yield* processes.liveness(pid)) !== "exited") alive.push(pid)
          if (alive.length === 0 || (yield* Clock.currentTimeMillis) >= deadline) break
          yield* Effect.sleep(TREE_EXIT_POLL)
        }
      }
      const confirmed =
        pane === "kept"
          ? { state: "unknown" as const, why: "its terminal was not closed, so nothing is proven" }
          : yield* confirmExited
      const processState: ProcessState = confirmed.state
      if (processState === "exited" && exitedAt(session) === null) {
        yield* db.session.endProcess(id, "archived")
      }
      let shared = false
      const g = exists ? yield* gitState(worktree) : undefined
      const multiGit = exists ? yield* workspaceGit(worktree).pipe(Effect.orDie) : undefined
      const root = exists
        ? yield* mainCheckout(worktree).pipe(Effect.option, Effect.map(Option.getOrUndefined))
        : undefined
      const linked = (repoRoot: string, path: string) =>
        Effect.gen(function* () {
          const at = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => path))
          return (yield* Git.Service.use((git) => git.linkedWorktrees(repoRoot))).includes(at)
        })
      const keepWorktree = Effect.gen(function* () {
        if (input.keepWorktree) return "worktree kept as asked (--keep-worktree)"
        if (!worktree.startsWith(layout.worktrees + "/"))
          return `${worktree} is not under ${layout.worktrees}; left alone`
        const sharing = (live: ReadonlyArray<string>) =>
          live.length > 0 ? `worktree kept: session ${live.join(", ")} still works in it` : undefined
        const liveSharers = db.session.liveSharers(id)
        const early = sharing(yield* liveSharers)
        if (early) {
          shared = true
          return early
        }
        const removeLinked = (repoRoot: string, path: string) =>
          Effect.gen(function* () {
            const state = yield* gitState(path)
            if (!state?.saved) return { stop: false, reason: `worktree kept: ${state?.why ?? "git cannot read it"}` }
            const again = sharing(yield* liveSharers)
            if (again) {
              shared = true
              return { stop: true, reason: again }
            }
            const refused = yield* removeWorktree(repoRoot, path).pipe(
              Effect.as(undefined),
              Effect.catchTag("GitError", (e) => Effect.succeed(e.message)),
            )
            return refused === undefined ? undefined : { stop: false, reason: `worktree kept: git refused: ${refused}` }
          })
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
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Git.Service, git),
    )

  return { release }
})
