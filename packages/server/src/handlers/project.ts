import { Db } from "@vibest/core/database/db"
import { Identity } from "@vibest/core/identity"
import { Project } from "@vibest/core/project"
import { createProject } from "@vibest/core/project/create"
import { moveProjectHere, resolveProject } from "@vibest/core/project/identity"
import { remoteHeaders } from "@vibest/protocol/protocol"
import { Caller, Forbidden } from "@vibest/protocol/rpc"
import { Effect, Predicate } from "effect"

import { Machines } from "../machine/machines.ts"
import * as CallerChecks from "./caller.ts"
import type { Handlers } from "./caller.ts"
import { group } from "./group.ts"

export const make = Effect.gen(function* () {
  const { scope, cliOnly, userOnly, atProject } = yield* CallerChecks.Service
  const db = yield* Db.Service
  const self = yield* Identity.Service
  const machines = yield* Machines.Service
  const project = yield* Project.Service

  return {
    "Project.Open": ({ directory, machine }) =>
      Effect.gen(function* () {
        const caller = yield* Caller
        const away = machine !== undefined

        if (away) {
          if (Predicate.isTagged(caller, "Remote"))
            return yield* new Forbidden({
              method: "Project.Open",
              message: "a remote opens projects only on this machine",
            })
          const link = yield* machines.link(machine!)

          return yield* link
            .call(
              link.client["Project.Open"](directory === undefined ? {} : { directory }, {
                headers: remoteHeaders(self.id),
              }),
            )
            .pipe(Effect.catchTag("NoSuchSession", (e) => Effect.die(e)))
        }

        if (!Predicate.isTagged(caller, "Remote")) yield* userOnly("Project.Open")
        const target = directory ?? (Predicate.isTagged(caller, "Cli") ? caller.repositoryRoot : undefined)

        if (target === undefined)
          return yield* new Forbidden({ method: "Project.Open", message: "Project.Open needs directory" })

        const opened = yield* resolveProject(db, yield* atProject(target))

        return { projectId: opened.id, directory: opened.directory }
      }),

    "Project.Move": ({ from }) =>
      Effect.gen(function* () {
        const c = yield* cliOnly("Project.Move")
        const moved = yield* moveProjectHere(db, yield* atProject(c.repositoryRoot), from)

        return {
          projectId: moved.id,
          directory: moved.directory,
          from: moved.from,
          repaired: moved.repaired,
          manual: moved.manual,
        }
      }),

    "Project.Create": ({ directory, from }) =>
      Effect.gen(function* () {
        const c = yield* userOnly("Project.Create")

        const created = yield* createProject(
          directory,
          from,
          Predicate.isTagged(c, "Cli") ? c.repositoryRoot : directory,
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

    "Project.Info": () => scope("Project.Info").pipe(Effect.flatMap(project.info)),

    "Project.Search": (input) => scope("Project.Search").pipe(Effect.flatMap((s) => project.search(s, input))),
  } satisfies Handlers
})

export const layer = group([
  "Project.Open",
  "Project.Move",
  "Project.Create",
  "Project.Info",
  "Project.Search",
]).toLayer(make)
