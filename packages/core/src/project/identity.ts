import { Layout } from "@vibest/schema/layout"
import { MoveRefused } from "@vibest/schema/session"
import { Effect, FileSystem, Path } from "effect"

import { projectRepositories, projectRoot } from "./create.ts"
import type { ProjectStore } from "./store.ts"

export const locateProject = Effect.fn("Project.locateProject")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath((yield* projectRoot(directory)).root)

  return { root, repositories: yield* projectRepositories(root) }
})

export type Located = Effect.Success<ReturnType<typeof locateProject>>

const repairWorktrees = Effect.fn("Project.repairWorktrees")(function* (repositories: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const worktrees = (yield* Layout).worktrees
  const root = yield* fs.realPath(worktrees).pipe(Effect.orElseSucceed(() => worktrees))
  const repaired: Array<string> = []
  const manual: Array<string> = []

  for (const repository of repositories) {
    const admin = path.join(repository, ".git", "worktrees")
    const names = yield* fs.readDirectory(admin).pipe(Effect.orElseSucceed((): Array<string> => []))

    for (const name of names) {
      const gitFile = (yield* fs
        .readFileString(path.join(admin, name, "gitdir"))
        .pipe(Effect.orElseSucceed(() => ""))).trim()

      if (gitFile === "" || !path.isAbsolute(gitFile)) continue
      const worktree = path.dirname(gitFile)

      if (!worktree.startsWith(`${root}${path.sep}`)) {
        manual.push(`git -C ${repository} worktree repair ${worktree}`)
        continue
      }

      const line = `gitdir: ${path.join(admin, name)}\n`
      const now = yield* fs.readFileString(gitFile).pipe(Effect.orElseSucceed(() => undefined))

      if (now === undefined || now === line) continue
      yield* fs.writeFileString(gitFile, line).pipe(Effect.orDie)
      repaired.push(worktree)
    }
  }

  return { repaired, manual }
})

export const resolveProject = Effect.fn("Project.resolveProject")(function* (
  projectStore: ProjectStore.Interface,
  located: Located,
) {
  const found = yield* projectStore.projectAt(located.root)

  if (found !== undefined) {
    yield* projectStore.refreshRepositories(found.id, located.repositories)

    return { id: found.id, directory: found.directory ?? located.root }
  }

  const id = yield* projectStore.createProject(located.root, located.repositories)

  return { id, directory: located.root }
})

const resolveThroughExistingAncestor = Effect.fn("Project.resolveThroughExistingAncestor")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const resolve = (current: string, suffix: string[]): Effect.Effect<string> =>
    fs.realPath(current).pipe(
      Effect.map((real) => path.join(real, ...suffix)),
      Effect.catch(() => {
        const up = path.dirname(current)

        return up === current ? Effect.succeed(target) : resolve(up, [path.basename(current), ...suffix])
      }),
    )

  return yield* resolve(target, [])
})

export const moveProjectHere = Effect.fn("Project.moveProjectHere")(function* (
  projectStore: ProjectStore.Interface,
  located: Located,
  from: string,
) {
  const fs = yield* FileSystem.FileSystem
  const old = yield* resolveThroughExistingAncestor(from)
  const recorded = yield* projectStore.projectAt(old)

  if (recorded === undefined || recorded.directory !== old)
    return yield* new MoveRefused({ message: `no project is recorded at ${old}` })

  if ((yield* projectStore.projectAt(located.root)) !== undefined)
    return yield* new MoveRefused({ message: `a project is already recorded at ${located.root}` })

  if (yield* fs.exists(old).pipe(Effect.orElseSucceed(() => false)))
    return yield* new MoveRefused({ message: `${old} still exists; the project has not moved` })
  const fixed = yield* repairWorktrees(located.repositories.map((r) => r.path))
  yield* projectStore.moveProject(recorded.id, located.root, located.repositories)

  return { id: recorded.id, directory: located.root, from: old, ...fixed }
})
