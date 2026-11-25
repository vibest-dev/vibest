import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import { Forbidden, WatchLagged } from "../errors.ts"
import { CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"
import { WatchEvent } from "../schemas.ts"

export const WatchGroup = HttpApiGroup.make("server.watch")
  .add(
    HttpApiEndpoint.get("watch.subscribe", "/api/watch", {
      success: HttpApiSchema.StreamSse({ data: WatchEvent, error: WatchLagged, keepAlive: "15 seconds" }),
      error: [Forbidden, WatchLagged],
    }).annotateMerge(OpenApi.annotations({ identifier: "watch.subscribe", summary: "Subscribe to live watch stream" })),
  )
  .middleware(CallerMiddleware)
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "watch" }))
