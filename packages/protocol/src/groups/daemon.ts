import { LaunchFailed } from "@vibest/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { DaemonBusy, DaemonStopping, Forbidden, WrongInstance } from "../errors.ts"
import { CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"
import { PingResult } from "../schemas.ts"

export const DaemonGroup = HttpApiGroup.make("server.daemon")
  .add(
    HttpApiEndpoint.get("daemon.ping", "/api/daemon/ping", {
      success: PingResult,
    }).annotateMerge(OpenApi.annotations({ identifier: "daemon.ping", summary: "Ping daemon" })),
  )
  .add(
    HttpApiEndpoint.get("daemon.concurrency", "/api/daemon/concurrency", {
      success: Schema.Struct({
        max: Schema.NullOr(Schema.Number),
        problems: Schema.Array(Schema.String),
        unsupported: Schema.Array(Schema.String),
      }),
    })
      .middleware(ProtocolMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "daemon.concurrency", summary: "Concurrency rules" })),
  )
  .add(
    HttpApiEndpoint.post("daemon.republish", "/api/daemon/republish", {
      success: Schema.Number,
    })
      .middleware(ProtocolMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "daemon.republish", summary: "Republish projections" })),
  )
  .add(
    HttpApiEndpoint.post("daemon.stop", "/api/daemon/stop", {
      payload: Schema.Struct({ instance: Schema.String }),
      success: Schema.Struct({ instance: Schema.String }),
      error: [Forbidden, WrongInstance, DaemonBusy, DaemonStopping],
    })
      .middleware(CallerMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "daemon.stop", summary: "Stop daemon" })),
  )
  .add(
    HttpApiEndpoint.post("daemon.handoff", "/api/daemon/handoff", {
      payload: Schema.Struct({ instance: Schema.String, command: Schema.Array(Schema.String) }),
      success: Schema.Struct({ instance: Schema.String }),
      error: [Forbidden, WrongInstance, DaemonBusy, DaemonStopping, LaunchFailed],
    })
      .middleware(CallerMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "daemon.handoff", summary: "Hand off daemon" })),
  )
  .annotateMerge(OpenApi.annotations({ title: "daemon" }))
