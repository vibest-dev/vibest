import { UnknownError } from "@vibest/protocol/errors"
import { Cause, Effect, Predicate } from "effect"
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"

const respond = HttpServerResponse.schemaJson(UnknownError)

const randomRef = () => `err_${Math.random().toString(16).slice(2, 10)}`

export const defectResponseLayer = HttpRouter.middleware(
  (effect) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const [response] = yield* HttpServerError.causeResponse(cause)

          if (response.status !== 500 || !Predicate.isTagged(response.body, "Empty"))
            return yield* Effect.failCause(cause)
          const request = yield* HttpServerRequest.HttpServerRequest
          const ref = randomRef()
          yield* Effect.logError("request failed", cause).pipe(
            Effect.annotateLogs({ ref, route: `${request.method} ${request.url}` }),
          )

          const body = yield* respond(
            new UnknownError({
              message: "Server failed to handle the request. Check server logs for details.",
              ref,
            }),
            { status: 500 },
          ).pipe(Effect.orDie)

          return yield* Effect.failCause(Cause.combine(cause, Cause.die(body)))
        }),
      ),
    ),
  { global: true },
)
