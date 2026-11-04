// The workspace port's implementation (core/workspace.ts): a project is a git checkout or a directory of them, and a
// session works in a detached worktree of each, under the worktrees root. Its name, its making, and the checks before
// it is taken away are the product's; the engine only asks.
import { Layout, safeRepositoryDirectory } from "@vibest/core/paths"
import { type Released, Workspace, WorkspaceRefused } from "@vibest/core/workspace"
import { Crypto, Effect, Exit, FileSystem, Layer, Option, Path } from "effect"
import { Hex } from "effect/encoding"
import { ChildProcessSpawner } from "effect/process"

import {
  createIsolatedWorktrees,
  discardIsolatedWorktrees,
  listProjectRepositories,
  projectRoot,
  workspaceGit,
} from "./project-create.ts"
import {
  addWorktree,
  allocationParentBlocked,
  copyIncluded,
  git,
  gitState,
  mainCheckout,
  repositoryDirectoryName,
} from "./worktree.ts"

type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto

/** A worktree's leaf name: 4 hex, drawn at random until an unused one is reserved. */
const ALLOCATION_LEAF = /^[0-9a-f]{4}$/
const ALLOCATION_NAME_ATTEMPTS = 16

/** Test hook: the 4-hex leaves `reserve` tries, in order, instead of random ones. */
export const allocationNameSource: { leaves: ReadonlyArray<string> | undefined } = { leaves: undefined }

export const layer = Layer.effect(
  Workspace,
  Effect.gen(function* () {
    const platform = yield* Effect.context<Platform>()
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const run = <A, E>(effect: Effect.Effect<A, E, Platform>) => Effect.provideContext(effect, platform)

    /** Undo a step only when the whole start failed (reverse order, uninterruptible). */
    const undoOnFailure = <A, E, R>(acquire: Effect.Effect<A, E, R>, undo: (a: A) => Effect.Effect<unknown, unknown>) =>
      Effect.acquireRelease(acquire, (a, exit) => (Exit.isFailure(exit) ? undo(a).pipe(Effect.ignore) : Effect.void))

    /** Whether `path` is a linked worktree of `repository` (its main checkout does not count). */
    const isLinked = (repository: string, at: string) =>
      run(
        Effect.gen(function* () {
          const real = yield* fs.realPath(at).pipe(Effect.orElseSucceed(() => at))
          const lines = (yield* git(repository, "worktree", "list", "--porcelain").pipe(
            Effect.orElseSucceed(() => ""),
          )).split("\n")
          // Porcelain lists the main checkout first: it does not count.
          return lines
            .filter((line) => line.startsWith("worktree "))
            .slice(1)
            .includes(`worktree ${real}`)
        }),
      )

    const reserve = (root: string) =>
      run(
        Effect.gen(function* () {
          const refuse = (message: string) => new WorkspaceRefused({ message })
          const folders = yield* listProjectRepositories(root).pipe(
            Effect.mapError((e) => refuse(`${root}: ${e.message}`)),
          )
          // `<worktrees>/<project>/<leaf>/<repository>` for a multi-repository project; otherwise the repository's own name.
          const repository = folders
            ? path.basename(root)
            : yield* repositoryDirectoryName(root).pipe(Effect.mapError((e) => refuse(e.message)))
          if (!safeRepositoryDirectory(repository))
            return yield* refuse(
              `repository name ${JSON.stringify(repository)} cannot be a directory under worktrees (empty, unsafe, or an 8-hex legacy session id)`,
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
          const scripted = allocationNameSource.leaves
          const attempts =
            scripted === undefined ? ALLOCATION_NAME_ATTEMPTS : Math.min(scripted.length, ALLOCATION_NAME_ATTEMPTS)
          for (let i = 0; i < attempts; i++) {
            const candidate = scripted?.[i] ?? Hex.encode(yield* crypto.randomBytes(2).pipe(Effect.orDie))
            if (!ALLOCATION_LEAF.test(candidate)) continue
            const where = layout.allocationWorktree(repository, candidate)
            // The name is reserved by creating its directory: an atomic mkdir, which fails when anything is there.
            const made = yield* fs.makeDirectory(where).pipe(
              Effect.as(true),
              Effect.catchTag("PlatformError", (e) =>
                e.reason._tag === "AlreadyExists"
                  ? Effect.succeed(false)
                  : Effect.fail(refuse(`${where}: ${e.message}`)),
              ),
            )
            if (made) return where
          }
          return yield* refuse(`no unused 4-hex worktree name under ${repository} after ${attempts} attempts`)
        }),
      )

    const prepare = (root: string, worktree: string, shared: boolean) =>
      Effect.gen(function* () {
        const folders = yield* run(listProjectRepositories(root))
        if (!shared) {
          // `reserve` made the directory, empty. A failed start removes it again, unless git left something in it
          // (a refused undo leaves it for `vibest archive`).
          yield* undoOnFailure(Effect.void, () =>
            fs
              .readDirectory(worktree)
              .pipe(
                Effect.flatMap((left) => (left.length === 0 ? fs.remove(worktree, { recursive: true }) : Effect.void)),
              ),
          )
          // Detached, made by vibest: a linked worktree of the main checkout would group away from the project's
          // terminals. Undone without force (it deletes ignored files, refuses on anything else); a refusal leaves it
          // for `vibest archive`. One detached worktree per repository of a multi-repository project.
          yield* undoOnFailure(
            run(folders ? createIsolatedWorktrees(folders, worktree).pipe(Effect.asVoid) : addWorktree(root, worktree)),
            () =>
              run<unknown, unknown>(
                folders ? discardIsolatedWorktrees(worktree) : git(root, "worktree", "remove", worktree),
              ),
          )
        }
        if (!folders) yield* run(copyIncluded(root, worktree))
      })

    const release = (input: {
      readonly id: string
      readonly path: string
      readonly keep: boolean
      readonly processes: { readonly state: "exited" | "alive" | "unknown"; readonly why: string }
      readonly liveSharers: Effect.Effect<ReadonlyArray<string>>
    }) =>
      run(
        Effect.gen(function* () {
          const worktree = input.path
          const exists = worktree !== "" && (yield* fs.exists(worktree).pipe(Effect.orElseSucceed(() => false)))
          if (!exists)
            return { worktree: "gone", reason: `${worktree} was already gone`, shared: false, branch: null } as Released
          /** The directory stays because another live session works in it. */
          let shared = false
          const g = yield* gitState(worktree)
          const multiGit = yield* workspaceGit(worktree).pipe(Effect.orDie)
          const root = yield* mainCheckout(worktree).pipe(Effect.option, Effect.map(Option.getOrUndefined))
          const sharing = (live: ReadonlyArray<string>) =>
            live.length > 0 ? `worktree kept: session ${live.join(", ")} still works in it` : undefined
          /** Why the worktree stays, checked in this order and only as far as needed; undefined once git removed it. */
          const keepWorktree = Effect.gen(function* () {
            if (input.keep) return "worktree kept as asked (--keep-worktree)"
            // Only a directory vibest made: one under its worktrees root.
            if (!worktree.startsWith(layout.worktrees + "/"))
              return `${worktree} is not under ${layout.worktrees}; left alone`
            const early = sharing(yield* input.liveSharers)
            if (early) {
              shared = true
              return early
            }
            // Re-read git and sharers immediately before `worktree remove`. Undefined: removed.
            /** Removed: undefined. A live sharer stops the whole removal; any other keep stays on this worktree. */
            const removeLinked = (repoRoot: string, at: string) =>
              Effect.gen(function* () {
                const state = yield* gitState(at)
                if (!state?.saved)
                  return { stop: false, reason: `worktree kept: ${state?.why ?? "git cannot read it"}` }
                const again = sharing(yield* input.liveSharers)
                if (again) {
                  shared = true
                  return { stop: true, reason: again }
                }
                const refused = yield* git(repoRoot, "worktree", "remove", at).pipe(
                  Effect.as(undefined),
                  Effect.catchTag("GitError", (e) => Effect.succeed(e.message)),
                )
                return refused === undefined
                  ? undefined
                  : { stop: false, reason: `worktree kept: git refused: ${refused}` }
              })
            // Another terminal still works there: its shell keeps the worktree. The engine's proof (no process of this
            // user with its cwd there) is the check that covers this.
            // A multi-repository workspace is not itself a worktree: the same removal per repository, then the directory if empty.
            const linked = root !== undefined && (yield* isLinked(root, worktree))
            const children = linked ? undefined : yield* listProjectRepositories(worktree).pipe(Effect.orDie)
            if (!linked && !children) return `${worktree} is not a worktree of its repository; left alone`
            if (input.processes.state !== "exited") return `worktree kept: ${input.processes.why}`
            if (children) {
              const notes: string[] = []
              for (const child of children) {
                const repoRoot = yield* mainCheckout(child.path).pipe(Effect.option, Effect.map(Option.getOrUndefined))
                if (repoRoot === undefined || !(yield* isLinked(repoRoot, child.path))) {
                  notes.push(`${child.name}: ${child.path} is not a worktree of its repository; left alone`)
                  continue
                }
                const kept = yield* removeLinked(repoRoot, child.path)
                if (kept === undefined) continue
                if (kept.stop) return [kept.reason, ...notes].join("; ")
                notes.push(`${child.name}: ${kept.reason}`)
              }
              if (notes.length > 0) return notes.join("; ")
              const left = yield* fs
                .readDirectory(worktree)
                .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
              if (left.length === 0) yield* fs.remove(worktree, { recursive: true }).pipe(Effect.ignore)
              return undefined
            }
            if (root === undefined) return `${worktree} is not a worktree of its repository; left alone`
            return (yield* removeLinked(root, worktree))?.reason
          })
          const kept = yield* keepWorktree
          const branch = multiGit
            ? multiGit
                .map((r) => (r.branch ? `${r.name}=${r.branch}` : ""))
                .filter(Boolean)
                .join("\n") || null
            : g?.branch || null
          return {
            worktree: kept === undefined ? "removed" : "kept",
            reason: kept,
            shared,
            branch,
          } as Released
        }),
      )

    return Workspace.of({
      project: (directory) => run(projectRoot(directory)),
      repositories: (directory) => run(listProjectRepositories(directory)),
      mainCheckout: (directory) => run(mainCheckout(directory)),
      reserve,
      prepare,
      state: (at) => run(gitState(at)),
      repositoryStates: (at) => run(workspaceGit(at)),
      release,
    })
  }),
)
