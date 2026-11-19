import { Layout } from "@vibest/schema/layout"
import { MoveRefused } from "@vibest/schema/session"
import { Effect, FileSystem, Path } from "effect"

import type { Db } from "../database/db.ts"
import { projectRepositories, projectRoot, repositoryPlace } from "./create.ts"

export const locateProject = Effect.fn("Project.locateProject")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const found = yield* projectRoot(directory)
  const root = yield* fs.realPath(found.root)

  return { root, repositories: found.checkout ? [yield* repositoryPlace(root)] : yield* projectRepositories(root) }
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

export const resolveProject = Effect.fn("Project.resolveProject")(function* (db: Db.Interface, located: Located) {
  const found = yield* db.project.projectAt(located.root)

  if (found !== undefined) {
    yield* db.project.refreshRepositories(found.id, located.repositories)

    return { id: found.id, directory: found.directory ?? located.root }
  }

  const id = yield* db.project.createProject(located.root, located.repositories)

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
  db: Db.Interface,
  located: Located,
  from: string,
) {
  const fs = yield* FileSystem.FileSystem
  const old = yield* resolveThroughExistingAncestor(from)
  const recorded = yield* db.project.projectAt(old)

  if (recorded === undefined || recorded.directory !== old)
    return yield* new MoveRefused({ message: `no project is recorded at ${old}` })

  if ((yield* db.project.projectAt(located.root)) !== undefined)
    return yield* new MoveRefused({ message: `a project is already recorded at ${located.root}` })

  if (yield* fs.exists(old).pipe(Effect.orElseSucceed(() => false)))
    return yield* new MoveRefused({ message: `${old} still exists; the project has not moved` })
  const fixed = yield* repairWorktrees(located.repositories.map((r) => r.path))
  yield* db.project.moveProject(recorded.id, located.root, located.repositories)

  return { id: recorded.id, directory: located.root, from: old, ...fixed }
})
