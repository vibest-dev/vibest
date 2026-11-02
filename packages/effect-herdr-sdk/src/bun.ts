// Bun implementations of what the core leaves abstract. The only SDK file that names a runtime.
import { BunPath, BunSocket } from "@effect/platform-bun"
import { Layer } from "effect"
import { SocketConnector } from "./socket-connector.js"

export const layerSocketConnector = Layer.succeed(SocketConnector, (endpoint) => BunSocket.makeNet({ path: endpoint }))

/** Everything `Herdr.layer` needs on Bun. */
export const layer = Layer.mergeAll(layerSocketConnector, BunPath.layer)
