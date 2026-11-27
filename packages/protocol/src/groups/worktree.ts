import { MachineName } from "@vibest/schema/id"
import { MachineIncompatible, MachineUnavailable, UnknownMachine } from "@vibest/schema/machine"
import { NoSuchProject } from "@vibest/schema/project"
import { WorktreeList } from "@vibest/schema/worktree"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { ProtocolMiddleware } from "../middleware.ts"

export const WorktreeGroup = HttpApiGroup.make("server.worktree")
  .add(
    HttpApiEndpoint.get("worktree.list", "/api/worktree", {
      query: Schema.Struct({
        project: Schema.optional(Schema.String),
        machine: Schema.optional(MachineName),
      }),
      success: WorktreeList,
      error: [Forbidden, NoSuchProject, UnknownMachine, MachineUnavailable, MachineIncompatible],
    }).annotateMerge(OpenApi.annotations({ identifier: "worktree.list", summary: "List worktrees" })),
  )
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "worktree" }))
