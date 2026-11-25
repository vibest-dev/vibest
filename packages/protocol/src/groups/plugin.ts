import { PluginInfo } from "@vibest/schema/plugin"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { ProtocolMiddleware } from "../middleware.ts"

export const PluginGroup = HttpApiGroup.make("server.plugin")
  .add(
    HttpApiEndpoint.get("plugin.list", "/api/plugin", {
      success: Schema.Array(PluginInfo),
    }).annotateMerge(OpenApi.annotations({ identifier: "plugin.list", summary: "List loaded plugins" })),
  )
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "plugin" }))
