import { MachineName } from "@vibest/schema/id"
import {
  AlreadyAdded,
  MachineFailed,
  MachineIncompatible,
  MachineInfo,
  MachineLoad,
  MachineNote,
  MachineUnavailable,
  UnknownMachine,
} from "@vibest/schema/machine"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"
import { MachineAddSuccess } from "../payloads.ts"

export const MachineGroup = HttpApiGroup.make("server.machine")
  .add(
    HttpApiEndpoint.get("machine.list", "/api/machine", {
      success: Schema.Array(MachineInfo),
      error: [Forbidden],
    }).annotateMerge(OpenApi.annotations({ identifier: "machine.list", summary: "List machines" })),
  )
  .add(
    HttpApiEndpoint.post("machine.add", "/api/machine", {
      payload: Schema.Struct({ name: MachineName, target: Schema.String }),
      success: MachineAddSuccess,
      error: [Forbidden, MachineFailed, MachineIncompatible, AlreadyAdded],
    }).annotateMerge(OpenApi.annotations({ identifier: "machine.add", summary: "Add machine" })),
  )
  .add(
    HttpApiEndpoint.get("machine.load", "/api/machine/load", {
      query: Schema.Struct({ machine: Schema.optional(MachineName) }),
      success: MachineLoad,
      error: [Forbidden, UnknownMachine, MachineUnavailable, MachineIncompatible],
    }).annotateMerge(OpenApi.annotations({ identifier: "machine.load", summary: "Read machine load" })),
  )
  .add(
    HttpApiEndpoint.delete("machine.remove", "/api/machine/:name", {
      params: Schema.Struct({ name: MachineName }),
      success: Schema.Struct({ notes: Schema.Array(MachineNote) }),
      error: [Forbidden, UnknownMachine],
    }).annotateMerge(OpenApi.annotations({ identifier: "machine.remove", summary: "Remove machine" })),
  )
  .middleware(CallerMiddleware)
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "machine" }))
