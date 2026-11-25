import { withHeaders } from "@vibest/client/client"
import { Db } from "@vibest/core/database/db"
import { Git } from "@vibest/core/git"
import { Identity } from "@vibest/core/identity"
import { Project } from "@vibest/core/project"
import { createProject } from "@vibest/core/project/create"
import { moveProjectHere, resolveProject } from "@vibest/core/project/identity"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { Caller } from "@vibest/protocol/middleware"
import { remoteHeaders } from "@vibest/protocol/protocol"
import { Layout } from "@vibest/schema/layout"
import { Effect, FileSystem, Path, Predicate } from "effect"
import { HttpApiBuilder } from "effect/http-api"

import { Machines } from "../machine/machines.ts"
import { Remote } from "../machine/remote.ts"
import * as CallerChecks from "./caller.ts"

export const ProjectHandler = HttpApiBuilder.group(VibestApi, "server.project", (handlers) =>
  Effect.gen(function* () {
    const { scope, cliOnly, userOnly, atProject } = yield* CallerChecks.Service
    const db = yield* Db.Service
    const self = yield* Identity.Service
    const machines = yield* Machines.Service
    const project = yield* Project.Service
    const remote = yield* Remote.Service
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const git = yield* Git.Service
    const layout = yield* Layout

    const withProjectPlatform = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Git.Service | Layout>,
    ) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Git.Service, git),
        Effect.provideService(Layout, layout),
      )

    return handlers
      .handle("project.open", ({ payload: { directory, machine } }) =>
        Effect.gen(function* () {
          const caller = yield* Caller
          const away = machine !== undefined

          if (away) {
            if (Predicate.isTagged(caller, "Remote"))
              return yield* new Forbidden({
                method: "project.open",
                message: "a remote opens projects only on this machine",
              })
            const link = yield* machines.link(machine!)

            return yield* link
              .call(
                withHeaders(
                  link.client["server.project"]["project.open"]({
                    payload: directory === undefined ? {} : { directory },
                  }),
                  remoteHeaders(self.id),
                ),
              )
              .pipe(Effect.catchTag("NoSuchSession", (e) => Effect.die(e)))
          }

          if (!Predicate.isTagged(caller, "Remote")) yield* userOnly("project.open")
          const target = directory ?? (Predicate.isTagged(caller, "Cli") ? caller.repositoryRoot : undefined)

          if (target === undefined)
            return yield* new Forbidden({ method: "project.open", message: "project.open needs directory" })

          const opened = yield* resolveProject(db, yield* atProject(target))

          return { projectId: opened.id, directory: opened.directory }
        }),
      )
      .handle("project.move", ({ payload: { from } }) =>
        Effect.gen(function* () {
          const c = yield* cliOnly("project.move")
          const moved = yield* withProjectPlatform(moveProjectHere(db, yield* atProject(c.repositoryRoot), from))

          return {
            projectId: moved.id,
            directory: moved.directory,
            from: moved.from,
            repaired: moved.repaired,
            manual: moved.manual,
          }
        }),
      )
      .handle("project.create", ({ payload: { directory, from } }) =>
        Effect.gen(function* () {
          const c = yield* userOnly("project.create")

          const created = yield* withProjectPlatform(
            createProject(directory, from, Predicate.isTagged(c, "Cli") ? c.repositoryRoot : directory),
          )

          return {
            directory: created.directory,
            folders: created.folders.map((folder) => ({
              name: folder.name,
              source: folder.source,
              path: folder.path,
              branch: folder.branch,
              uncommitted: [...folder.uncommitted],
              ...(folder.origin !== undefined && { origin: folder.origin }),
            })),
          }
        }),
      )
      .handle("project.info", () => scope("project.info").pipe(Effect.flatMap(project.info)))
      .handle("project.search", ({ query }) =>
        scope("project.search").pipe(Effect.flatMap((s) => project.search(s, query))),
      )
      .handle("project.clone", ({ payload: { url, directory, machine } }) =>
        Effect.gen(function* () {
          const away = machine !== undefined

          if (away && Predicate.isTagged(yield* Caller, "Remote"))
            return yield* new Forbidden({ method: "project.clone", message: "a remote clones only on this machine" })

          return remote.clone(away ? machine : undefined, { url, directory })
        }),
      )
  }),
)
