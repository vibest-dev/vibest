import { Plugins } from "@vibest/core/plugin"
import { VibestApi } from "@vibest/protocol/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"

export const PluginHandler = HttpApiBuilder.group(VibestApi, "server.plugin", (handlers) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins.Service

    return handlers.handle("plugin.list", () => plugins.list)
  }),
)
