import os from "node:os"

import { InboxStore } from "@vibest/core/inbox/store"
import { ProjectStore } from "@vibest/core/project/store"
import { SessionStore } from "@vibest/core/session/store"
import { Effect, FileSystem } from "effect"

export const projectOf = (directory: string) =>
  Effect.gen(function* () {
    const projectStore = yield* ProjectStore.Service

    return (yield* projectStore.projectAt(directory))?.id ?? (yield* projectStore.createProject(directory, []))
  })

export const tempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ directory: os.tmpdir(), prefix }))
  }).pipe(Effect.orDie)

export const entryPending = (
  sessionStore: SessionStore.Interface,
  inboxStore: InboxStore.Interface,
  projectId: string,
) =>
  Effect.flatMap(sessionStore.latestRoot(projectId), (entry) =>
    entry === undefined ? Effect.succeed([]) : inboxStore.pendingInbox(entry.id),
  )
