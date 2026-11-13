import { Db } from "@vibest/core/database/db"
import { Effect, FileSystem } from "effect"

export const projectOf = (directory: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    return (yield* db.projectAt(directory))?.id ?? (yield* db.createProject(directory, []))
  })

export const tempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }))
  }).pipe(Effect.orDie)

export const entryPending = (db: Db["Service"], projectId: string) =>
  Effect.flatMap(db.entryOf(projectId), (entry) =>
    entry === undefined ? Effect.succeed([]) : db.pendingInbox(entry.id),
  )
