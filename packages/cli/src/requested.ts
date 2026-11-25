import { awaitDaemon, type VibestClient } from "@vibest/client/client"
import type { Ping } from "@vibest/protocol/schemas"
import { Layout } from "@vibest/schema/layout"
import { Effect } from "effect"
import { HttpClientError } from "effect/http"

import { caller } from "./caller.ts"
import { withVibest } from "./client.ts"

export const requested = <A, E, R>(
  f: (
    client: VibestClient,
    request: string | undefined,
    ping: Ping,
  ) => Effect.Effect<A, E | HttpClientError.HttpClientError, R>,
) =>
  Effect.gen(function* () {
    const c = yield* caller
    const socket = (yield* Layout).socket
    const request = crypto.randomUUID()
    let known = false

    const call = (firstError?: HttpClientError.HttpClientError) =>
      withVibest(
        c.claim,
        (client, ping) => {
          known = ping.capabilities?.requests === true

          return firstError !== undefined && !known
            ? Effect.fail(firstError)
            : f(client, known ? request : undefined, ping)
        },
        { start: !c.agent },
      )

    return yield* call().pipe(
      Effect.catch((error) =>
        known && HttpClientError.isHttpClientError(error)
          ? awaitDaemon(socket).pipe(Effect.andThen(call(error)))
          : Effect.fail(error),
      ),
    )
  })
