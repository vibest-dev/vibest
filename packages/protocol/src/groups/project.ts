import { MachineName, ProjectId } from "@vibest/schema/id"
import { MachineIncompatible, MachineUnavailable, UnknownMachine } from "@vibest/schema/machine"
import {
  CloneFailed,
  CloneRequest,
  CloneStep,
  ProjectCreateFailed,
  ProjectInfoResult,
  ProjectKind,
} from "@vibest/schema/project"
import { MoveRefused, NotInRepository } from "@vibest/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { AdmissionMiddleware, CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"
import { ProjectCreateSuccess } from "../payloads.ts"

export const ProjectGroup = HttpApiGroup.make("server.project")
  .add(
    HttpApiEndpoint.post("project.open", "/api/project/open", {
      payload: Schema.Struct({
        directory: Schema.optional(Schema.String),
        machine: Schema.optional(MachineName),
      }),
      success: Schema.Struct({ projectId: ProjectId, directory: Schema.String }),
      error: [Forbidden, NotInRepository, UnknownMachine, MachineUnavailable, MachineIncompatible],
    }).annotateMerge(OpenApi.annotations({ identifier: "project.open", summary: "Open project" })),
  )
  .add(
    HttpApiEndpoint.post("project.create", "/api/project/create", {
      payload: Schema.Struct({ directory: Schema.String, from: Schema.Array(Schema.String) }),
      success: ProjectCreateSuccess,
      error: [Forbidden, ProjectCreateFailed],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "project.create", summary: "Create multi-repo project" })),
  )
  .add(
    HttpApiEndpoint.post("project.move", "/api/project/move", {
      payload: Schema.Struct({ from: Schema.String }),
      success: Schema.Struct({
        projectId: ProjectId,
        directory: Schema.String,
        from: Schema.String,
        repaired: Schema.Array(Schema.String),
        manual: Schema.Array(Schema.String),
      }),
      error: [Forbidden, NotInRepository, MoveRefused],
    }).annotateMerge(OpenApi.annotations({ identifier: "project.move", summary: "Move project" })),
  )
  .add(
    HttpApiEndpoint.get("project.info", "/api/project/info", {
      success: ProjectInfoResult,
      error: [Forbidden, NotInRepository],
    }).annotateMerge(OpenApi.annotations({ identifier: "project.info", summary: "Project info" })),
  )
  .add(
    HttpApiEndpoint.get("project.search", "/api/project/search", {
      query: Schema.Struct({
        query: Schema.String,
        kind: Schema.optional(ProjectKind),
      }),
      success: Schema.Array(Schema.String),
      error: [Forbidden, NotInRepository],
    }).annotateMerge(OpenApi.annotations({ identifier: "project.search", summary: "Search project folder" })),
  )
  .add(
    HttpApiEndpoint.post("project.clone", "/api/project/clone", {
      payload: Schema.Struct(CloneRequest),
      success: HttpApiSchema.StreamSse({ data: CloneStep, error: Schema.Union([Forbidden, CloneFailed]) }),
      error: [Forbidden, CloneFailed],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "project.clone", summary: "Clone project" })),
  )
  .middleware(CallerMiddleware)
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "project" }))
