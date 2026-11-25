import { Inbox } from "@vibest/core/inbox"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { Caller } from "@vibest/protocol/middleware"
import { Effect, Predicate } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"

import { processOf, reader } from "../gates.ts"

export const InboxHandler = HttpApiBuilder.group(VibestApi, "server.inbox", (handlers) =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.Service

    const pullingSession = (method: "inbox.subscribe" | "inbox.take") =>
      Effect.gen(function* () {
        const c = yield* Caller

        if (!Predicate.isTagged(c, "Session"))
          return yield* new Forbidden({ method, message: `${method} is a session's own` })

        return c.sessionId
      })

    return handlers
      .handle("inbox.take", () =>
        Effect.gen(function* () {
          const sessionId = yield* pullingSession("inbox.take")
          const request = yield* HttpServerRequest.HttpServerRequest

          return yield* inbox.take(sessionId, processOf(reader(request.headers)))
        }),
      )
      .handle("inbox.subscribe", () => Effect.map(pullingSession("inbox.subscribe"), inbox.stream))
  }),
)
