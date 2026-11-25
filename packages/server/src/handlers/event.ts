import { Bus } from "@vibest/core/bus"
import { SessionStore } from "@vibest/core/session/store"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { NoSuchSession } from "@vibest/schema/session"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/http-api"

import * as CallerChecks from "./caller.ts"

export const EventHandler = HttpApiBuilder.group(VibestApi, "server.event", (handlers) =>
  Effect.gen(function* () {
    const { cliOnly } = yield* CallerChecks.Service
    const sessionStore = yield* SessionStore.Service
    const bus = yield* Bus.Service

    return handlers.handle("event.subscribe", ({ query: { session, after, follow } }) =>
      Effect.gen(function* () {
        yield* cliOnly("event.subscribe")

        if (after !== undefined && session === undefined)
          return yield* new Forbidden({
            method: "event.subscribe",
            message: "after resumes one session's facts; give the session too",
          })

        const id =
          session === undefined
            ? undefined
            : yield* sessionStore
                .resolveSession(session)
                .pipe(
                  Effect.catchTag("AmbiguousSession", (e) =>
                    Effect.fail(new NoSuchSession({ id: session, message: e.message })),
                  ),
                )

        return bus.log({ aggregate: id, after, follow: follow === true }).pipe(
          Stream.map(({ id, type, created, durable, data }) => ({
            id,
            type,
            created,
            durable,
            data,
          })),
        )
      }),
    )
  }),
)
