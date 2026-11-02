// The one runtime capability the client needs and `effect` has no service for: dial a local socket.
// The client only names this service; the product's platform layer (or an integration) provides it.
import { Context, type Effect } from "effect"
import type * as Socket from "effect/socket/Socket"

/** Dial `endpoint` (a unix socket path). Like `WebSocketConstructor`, for local sockets. */
export class SocketConnector extends Context.Service<
  SocketConnector,
  (endpoint: string) => Effect.Effect<Socket.Socket>
>()("vibest/SocketConnector") {}
