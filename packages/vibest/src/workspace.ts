// The workspace port's implementation (core/workspace.ts): a project is a git checkout or a directory of them, and a
// session works in a detached worktree of each.
import { Workspace } from "@vibest/core/workspace"
import { Crypto, Effect, FileSystem, Layer, Path } from "effect"
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

export const layer = Layer.effect(
  Workspace,
  Effect.gen(function* () {
    const platform = yield* Effect.context<Platform>()
    const fs = yield* FileSystem.FileSystem
    const run = <A, E>(effect: Effect.Effect<A, E, Platform>) => Effect.provideContext(effect, platform)
    return Workspace.of({
      project: (directory) => run(projectRoot(directory)),
      repositories: (directory) => run(listProjectRepositories(directory)),
      mainCheckout: (directory) => run(mainCheckout(directory)),
      name: (directory) => run(repositoryDirectoryName(directory)),
      parentBlocked: (directory) => run(allocationParentBlocked(directory)),
      allocate: (root, path) =>
        run(
          Effect.gen(function* () {
            const folders = yield* listProjectRepositories(root)
            // One detached worktree per repository: a plain directory, not one linked worktree of the first.
            if (folders) return yield* createIsolatedWorktrees(folders, path).pipe(Effect.asVoid)
            yield* addWorktree(root, path)
          }),
        ),
      discard: (root, path) =>
        run(
          Effect.gen(function* () {
            if (yield* listProjectRepositories(root)) return yield* discardIsolatedWorktrees(path)
            yield* git(root, "worktree", "remove", path)
          }),
        ),
      copyIncluded: (root, path) => run(copyIncluded(root, path)),
      state: (path) => run(gitState(path)),
      repositoryStates: (path) => run(workspaceGit(path)),
      isLinked: (repository, path) =>
        run(
          Effect.gen(function* () {
            const at = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => path))
            const lines = (yield* git(repository, "worktree", "list", "--porcelain").pipe(
              Effect.orElseSucceed(() => ""),
            )).split("\n")
            // Porcelain lists the main checkout first: it does not count.
            return lines
              .filter((line) => line.startsWith("worktree "))
              .slice(1)
              .includes(`worktree ${at}`)
          }),
        ),
      removeLinked: (repository, path) => run(git(repository, "worktree", "remove", path).pipe(Effect.asVoid)),
    })
  }),
)
