import { Context, type Effect } from "effect"
import type * as Socket from "effect/socket/Socket"

export * as SocketConnector from "./socket-connector.ts"

export type Interface = (endpoint: string) => Effect.Effect<Socket.Socket>

export class Service extends Context.Service<Service, Interface>()("vibest/SocketConnector") {}
