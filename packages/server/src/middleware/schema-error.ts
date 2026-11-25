import { InvalidRequestError, UnknownError } from "@vibest/protocol/errors"
import { SchemaErrorMiddleware } from "@vibest/protocol/middleware"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"

const REASON_LIMIT = 1024

const truncateReason = (reason: string) =>
  reason.length <= REASON_LIMIT
    ? reason
    : `${reason.slice(0, REASON_LIMIT)}... (${reason.length - REASON_LIMIT} more chars)`

const randomRef = () => `err_${Math.random().toString(16).slice(2, 10)}`

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error, context) => {
  const reason = truncateReason(error.cause.message)

  if (error.kind === "Body" || error.kind === "ResponseHeaders") {
    const ref = randomRef()

    return Effect.logError("failed to encode response").pipe(
      Effect.annotateLogs({
        ref,
        kind: error.kind,
        endpoint: `${context.group.identifier}.${context.endpoint.identifier}`,
        route: `${context.endpoint.method} ${context.endpoint.path}`,
        reason,
      }),
      Effect.as(
        HttpServerResponse.jsonUnsafe(
          new UnknownError({
            message: "Server failed to encode its response. Check server logs for details.",
            ref,
          }),
          { status: 500 },
        ),
      ),
    )
  }

  return Effect.logWarning("schema rejection").pipe(
    Effect.annotateLogs({ kind: error.kind, reason }),
    Effect.andThen(Effect.fail(new InvalidRequestError({ message: reason, kind: error.kind }))),
  )
})
