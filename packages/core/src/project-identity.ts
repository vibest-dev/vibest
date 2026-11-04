// Where a project is (docs/design/schema.md, Projects): the project whose directory is the realpath of a project root,
// else the one with a repository there. Its id never changes; a directory or a remote is not identity.
import { Effect, FileSystem } from "effect"

import type { Db } from "./db.ts"
import { projectRepositories, projectRoot } from "./project-create.ts"

/** The project root of `directory` (`projectRoot`) as a realpath, with its repositories. */
export const locateProject = Effect.fn("locateProject")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath((yield* projectRoot(directory)).root)
  return { root, repositories: yield* projectRepositories(root) }
})
export type Located = Effect.Success<ReturnType<typeof locateProject>>

/** The project at `located`: found (its repositories as they are now) or created. Its id and directory. */
export const resolveProject = Effect.fn("resolveProject")(function* (db: Db["Service"], located: Located) {
  const found = yield* db.projectAt(located.root)
  if (found !== undefined) {
    yield* db.refreshRepositories(found.id, located.repositories)
    return { id: found.id, directory: found.directory ?? located.root }
  }
  return { id: yield* db.createProject(located.root, located.repositories), directory: located.root }
})
