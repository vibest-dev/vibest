import { entryPlace, specHits, filterCallerEnv } from "@vibest/core/caller"
import { Db } from "@vibest/core/database/db"
import { Project } from "@vibest/core/project"
import { createProject } from "@vibest/core/project/create"
import { resolveProject } from "@vibest/core/project/identity"
import { Runtimes } from "@vibest/core/runtimes"
import { LaunchFailed } from "@vibest/schema/session"
import { Effect } from "effect"

import type { Checks, Handlers } from "./caller.ts"

export const make = ({ scope, cliOnly, atProject, resolveAt }: Checks) =>
  Effect.gen(function* () {
    const db = yield* Db
    const project = yield* Project
    const runtimes = yield* Runtimes
    return {
      "Project.Open": ({ move }) =>
        Effect.gen(function* () {
          const c = yield* cliOnly("Project.Open")
          const project = yield* resolveProject(db, yield* atProject(c.repositoryRoot), move)
          return {
            projectId: project.id,
            directory: project.directory,
            ...("moved" in project ? { moved: project.moved } : {}),
            ...("candidates" in project ? { candidates: project.candidates } : {}),
          }
        }),

      "Project.EntryPlace": ({ callerEnv, runtime }) =>
        Effect.gen(function* () {
          const c = yield* cliOnly("Project.EntryPlace")
          const project = yield* resolveAt(c.repositoryRoot)
          const specs = yield* runtimes.callers
          const env = filterCallerEnv(specs, callerEnv)
          const hits = yield* specHits(specs, env, runtime).pipe(Effect.orDie)
          const place = entryPlace({ runtime, hits })
          if (place.in === "refused") return yield* new LaunchFailed({ message: place.message })
          if (place.in === "terminal") {
            const spec = specs.find((item) => item.id === place.runtime)
            if (spec?.ready !== undefined && !(yield* spec.ready(env).pipe(Effect.orDie)))
              return yield* new LaunchFailed({
                message: spec.missing ?? `this ${spec.name ?? place.runtime} place could not be named`,
              })
          }
          return { directory: project.directory, place }
        }),

      "Project.Create": ({ directory, from }) =>
        Effect.gen(function* () {
          const c = yield* cliOnly("Project.Create")
          const created = yield* createProject(directory, from, c.repositoryRoot)
          return {
            directory: created.directory,
            folders: created.folders.map((folder) => ({
              name: folder.name,
              source: folder.source,
              path: folder.path,
              branch: folder.branch,
              uncommitted: [...folder.uncommitted],
              ...(folder.origin === undefined ? {} : { origin: folder.origin }),
            })),
          }
        }),

      "Project.Info": () => scope("Project.Info").pipe(Effect.flatMap(project.info)),

      "Project.Search": (input) => scope("Project.Search").pipe(Effect.flatMap((s) => project.search(s, input))),
    } satisfies Handlers
  })
