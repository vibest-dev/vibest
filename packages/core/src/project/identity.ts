import { Layout } from "@vibest/schema/layout"
import { ProjectMoved } from "@vibest/schema/session"
import { Effect, FileSystem, Path } from "effect"

import type { Db } from "../database/db.ts"
import { projectRepositories, projectRoot } from "./create.ts"

export const locateProject = Effect.fn("locateProject")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath((yield* projectRoot(directory)).root)
  return { root, repositories: yield* projectRepositories(root) }
})
export type Located = Effect.Success<ReturnType<typeof locateProject>>

export interface Moved {
  readonly from: string
  readonly repaired: ReadonlyArray<string>
  readonly manual: ReadonlyArray<string>
}

const repairWorktrees = Effect.fn("repairWorktrees")(function* (repositories: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const worktrees = (yield* Layout).worktrees
  const root = yield* fs.realPath(worktrees).pipe(Effect.orElseSucceed(() => worktrees))
  const repaired: Array<string> = []
  const manual: Array<string> = []
  for (const repository of repositories) {
    const admin = path.join(repository, ".git", "worktrees")
    const names = yield* fs.readDirectory(admin).pipe(Effect.orElseSucceed(() => [] as Array<string>))
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

export const resolveProject = Effect.fn("resolveProject")(function* (
  db: Db["Service"],
  located: Located,
  move?: boolean,
) {
  const found = yield* db.projectAt(located.root)
  if (found !== undefined) {
    yield* db.refreshRepositories(found.id, located.repositories)
    return { id: found.id, directory: found.directory ?? located.root }
  }
  const fs = yield* FileSystem.FileSystem
  const remotes = located.repositories.flatMap((r) => (r.remote === undefined ? [] : [r.remote]))
  const candidates = yield* Effect.filter(yield* db.moveCandidates(remotes), (c) =>
    fs.exists(c.directory).pipe(
      Effect.map((exists) => !exists),
      Effect.orElseSucceed(() => false),
    ),
  )
  const [only] = candidates
  if (candidates.length === 1 && only !== undefined && move !== false) {
    if (move !== true) return yield* new ProjectMoved({ projectId: only.id, from: only.directory, to: located.root })
    const fixed = yield* repairWorktrees(located.repositories.map((r) => r.path))
    const from = yield* db.moveProject(only.id, located.root, located.repositories)
    return { id: only.id, directory: located.root, moved: { from, ...fixed } satisfies Moved }
  }
  const id = yield* db.createProject(located.root, located.repositories)
  return {
    id,
    directory: located.root,
    ...(candidates.length > 1 ? { candidates: candidates.map((c) => c.directory) } : {}),
  }
})
