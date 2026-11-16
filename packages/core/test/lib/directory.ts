import { Db } from "@vibest/core/database/db"
import { Effect, FileSystem } from "effect"

export const projectOf = (directory: string) =>
  Effect.gen(function* () {
    const db = yield* Db.Service
    return (yield* db.project.projectAt(directory))?.id ?? (yield* db.project.createProject(directory, []))
  })

export const tempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }))
  }).pipe(Effect.orDie)

export const entryPending = (db: Db.Interface, projectId: string) =>
  Effect.flatMap(db.session.entryOf(projectId), (entry) =>
    entry === undefined ? Effect.succeed([]) : db.inbox.pendingInbox(entry.id),
  )
