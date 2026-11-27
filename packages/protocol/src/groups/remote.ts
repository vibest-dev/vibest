import { NoCommit, NoProject, OutboxItem, PromptTooLarge } from "@vibest/schema/machine"
import { PluginsNotActive, SessionRefused } from "@vibest/schema/plugin"
import {
  AllocationFailed,
  AmbiguousSession,
  HarnessUnavailable,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  RuntimeIncompatible,
  RuntimeUnreachable,
  UnknownAgent,
} from "@vibest/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import { Forbidden, InvalidCaller } from "../errors.ts"
import { AdmissionMiddleware, CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"
import { RemoteHelloSuccess, RemoteSpawnPayload, RemoteSpawnSuccess } from "../payloads.ts"

const RemoteEdges = Schema.Array(
  Schema.Struct({ from: Schema.String, to: Schema.String, remote: Schema.optional(Schema.String) }),
)

export const RemoteGroup = HttpApiGroup.make("server.remote")
  .add(
    HttpApiEndpoint.post("remote.hello", "/api/remote/hello", {
      payload: Schema.Struct({ id: Schema.String, name: Schema.String, callsMe: Schema.String }),
      success: RemoteHelloSuccess,
      error: [Forbidden],
    }).annotateMerge(OpenApi.annotations({ identifier: "remote.hello", summary: "Handshake remote vibestd" })),
  )
  .add(
    HttpApiEndpoint.post("remote.spawn", "/api/remote/spawn", {
      payload: RemoteSpawnPayload,
      success: RemoteSpawnSuccess,
      error: [
        InvalidCaller,
        Forbidden,
        NoProject,
        NoCommit,
        PromptTooLarge,
        AllocationFailed,
        HarnessUnavailable,
        NoCallingSession,
        NoHarnessChosen,
        NoRuntime,
        SessionRefused,
        PluginsNotActive,
        UnknownAgent,
        NoSuchSession,
        RuntimeUnreachable,
        RuntimeIncompatible,
      ],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "remote.spawn", summary: "Spawn session for remote peer" })),
  )
  .add(
    HttpApiEndpoint.get("remote.outbox", "/api/remote/outbox", {
      success: HttpApiSchema.StreamSse({ data: OutboxItem, keepAlive: "15 seconds" }),
      error: [Forbidden],
    }).annotateMerge(OpenApi.annotations({ identifier: "remote.outbox", summary: "Stream remote outbox" })),
  )
  .add(
    HttpApiEndpoint.post("remote.ack", "/api/remote/ack", {
      payload: Schema.Struct({ ids: Schema.Array(Schema.String) }),
      success: HttpApiSchema.NoContent,
      error: [Forbidden],
    }).annotateMerge(OpenApi.annotations({ identifier: "remote.ack", summary: "Acknowledge remote outbox items" })),
  )
  .add(
    HttpApiEndpoint.post("remote.link", "/api/remote/link", {
      payload: Schema.Struct({ edges: RemoteEdges }),
      success: Schema.Struct({ edges: RemoteEdges }),
      error: [Forbidden, NoSuchSession, AmbiguousSession],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "remote.link", summary: "Link remote sessions" })),
  )
  .add(
    HttpApiEndpoint.post("remote.unlink", "/api/remote/unlink", {
      payload: Schema.Struct({ edges: RemoteEdges }),
      success: Schema.Struct({ edges: RemoteEdges }),
      error: [Forbidden, NoSuchSession, AmbiguousSession],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "remote.unlink", summary: "Unlink remote sessions" })),
  )
  .middleware(CallerMiddleware)
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "remote" }))
