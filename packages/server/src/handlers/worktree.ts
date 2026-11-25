import { Db } from "@vibest/core/database/db"
import { Git } from "@vibest/core/git"
import { list } from "@vibest/core/worktree-list"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { CALLER_HEADER } from "@vibest/protocol/protocol"
import { Layout } from "@vibest/schema/layout"
import { Effect, FileSystem, Path } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"

import { reader } from "../gates.ts"
import { Remote } from "../machine/remote.ts"

export const WorktreeHandler = HttpApiBuilder.group(VibestApi, "server.worktree", (handlers) =>
  Effect.gen(function* () {
    const remote = yield* Remote.Service
    const db = yield* Db.Service
    const git = yield* Git.Service
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const layout = yield* Layout

    const listed = (project: string | undefined) =>
      list(project).pipe(
        Effect.provideService(Db.Service, db),
        Effect.provideService(Git.Service, git),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Layout, layout),
      )

    return handlers.handle("worktree.list", ({ query: { project, machine } }) =>
      Effect.gen(function* () {
        if (machine !== undefined) {
          const request = yield* HttpServerRequest.HttpServerRequest

          if (reader(request.headers)(CALLER_HEADER) === "remote")
            return yield* new Forbidden({
              method: "worktree.list",
              message: "a remote asks for this machine's worktrees only",
            })

          return yield* remote.worktrees(machine, project)
        }

        return yield* listed(project)
      }),
    )
  }),
)
