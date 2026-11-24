import { Db } from "@vibest/core/database/db"
import { LOCAL_MACHINE } from "@vibest/core/database/ledger-read"
import { Git } from "@vibest/core/git"
import { list } from "@vibest/core/worktree-list"
import { CALLER_HEADER } from "@vibest/protocol/protocol"
import { Forbidden } from "@vibest/protocol/rpc"
import { Layout } from "@vibest/schema/layout"
import { Effect, FileSystem, Path } from "effect"

import { reader } from "../gates.ts"
import { Remote } from "../machine/remote.ts"
import type { Handlers } from "./caller.ts"
import { group } from "./group.ts"

export const make = Effect.gen(function* () {
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

  return {
    "Worktree.List": ({ project, machine }, { headers }) =>
      Effect.gen(function* () {
        if (machine !== undefined && machine !== LOCAL_MACHINE) {
          if (reader(headers)(CALLER_HEADER) === "remote")
            return yield* new Forbidden({
              method: "Worktree.List",
              message: "a remote asks for this machine's worktrees only",
            })

          return yield* remote.worktrees(machine, project)
        }

        return yield* listed(project)
      }),
  } satisfies Handlers
})

export const layer = group(["Worktree.List"]).toLayer(make)
