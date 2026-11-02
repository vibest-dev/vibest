// The one runtime capability the client needs and `effect` has no service for: dial a local socket.
// The core only names this service; `effect-herdr-sdk/bun` (or another runtime's layer) provides it.
import { Context, type Effect } from "effect"
import type * as Socket from "effect/socket/Socket"

/** Dial `endpoint` (a unix socket path, or `\\.\pipe\…` on Windows). Like `WebSocketConstructor`, for local sockets. */
export class SocketConnector extends Context.Service<SocketConnector, (endpoint: string) => Effect.Effect<Socket.Socket>>()(
  "effect-herdr-sdk/SocketConnector",
) {}
