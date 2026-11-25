import { Context, type Effect } from "effect"
import type * as Socket from "effect/socket/Socket"

export class SocketConnector extends Context.Service<
  SocketConnector,
  (endpoint: string) => Effect.Effect<Socket.Socket>
>()("effect-herdr-sdk/SocketConnector") {}
