// Where a project is (docs/design/schema.md, Projects): the project whose directory is the realpath of a project root,
// else the one with a repository there. Its id never changes; a directory or a remote is not identity.
import { ProjectMoved } from "@vibest/schema/session"
import { Effect, FileSystem, Path } from "effect"

import type { Db } from "./db.ts"
import { Layout } from "./paths.ts"
import { projectRepositories, projectRoot } from "./project-create.ts"

/** The project root of `directory` (`projectRoot`) as a realpath, with its repositories. */
export const locateProject = Effect.fn("locateProject")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath((yield* projectRoot(directory)).root)
  return { root, repositories: yield* projectRepositories(root) }
})
export type Located = Effect.Success<ReturnType<typeof locateProject>>

/** What a move did to the linked worktrees of the moved repositories. */
export interface Moved {
  readonly from: string
  /** vibest's own worktrees whose `.git` file now names the moved repository. */
  readonly repaired: ReadonlyArray<string>
  /** The user's worktrees, left alone: the command that repairs each. */
  readonly manual: ReadonlyArray<string>
}

/**
 * Each linked worktree of `repositories` (moved checkouts): one under vibest's worktrees root gets its `.git` file
 * pointed at the repository's new place, as `git worktree repair` would; any other is only named, with its command
 * (git's own repair rewrites every worktree of the repository, the user's included).
 */
const repairWorktrees = Effect.fn("repairWorktrees")(function* (repositories: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // git names worktrees by their realpath.
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

/**
 * The project at `located`: found (its repositories as they are now) or created. Its id and directory.
 * Not found, but exactly one project with the same origins sits at a directory that is gone: the checkout moved.
 * Without `move` that is `ProjectMoved`; `move: true` moves that project here (its id kept, vibest's worktrees
 * repaired), `move: false` creates another. Several such projects: a new one, the others named in `candidates`.
 */
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
    // Repaired before the move is recorded: a stop in between leaves the project where it was, so the next `vibest`
    // asks again and repairs again (nothing left to do) before it records the move.
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
