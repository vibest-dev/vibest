import { BunPath, BunSocket } from "@effect/platform-bun"
import { Layer } from "effect"

import { SocketConnector } from "./socket-connector.js"

export const layerSocketConnector = Layer.succeed(SocketConnector, (endpoint) => BunSocket.makeNet({ path: endpoint }))

export const layer = Layer.mergeAll(layerSocketConnector, BunPath.layer)
