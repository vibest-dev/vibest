import { awaitDaemon, type VibestClient } from "@vibest/client/client"
import { type Ping } from "@vibest/protocol/rpc"
import { Layout } from "@vibest/schema/layout"
import { Effect } from "effect"
import { RpcClientError as ClientError } from "effect/rpc"

import { caller } from "./caller.ts"
import { withVibest } from "./client.ts"

export const requested = <A, E, R>(
  f: (
    client: VibestClient,
    request: string | undefined,
    ping: Ping,
  ) => Effect.Effect<A, E | ClientError.RpcClientError, R>,
) =>
  Effect.gen(function* () {
    const c = yield* caller
    const socket = (yield* Layout).socket
    const request = crypto.randomUUID()
    let known = false
    const call = (firstError?: ClientError.RpcClientError) =>
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
        known && error instanceof ClientError.RpcClientError
          ? awaitDaemon(socket).pipe(Effect.andThen(call(error)))
          : Effect.fail(error),
      ),
    )
  })
