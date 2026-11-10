import { Effect, Layer, Schedule } from "effect"
import * as Socket from "effect/socket/Socket"

import { clientOver } from "./client.ts"

export const stdioSocket = (streams: Socket.InputTransformStream) => Socket.fromTransformStream(Effect.succeed(streams))

export const connectPipe = (socket: Socket.Socket) =>
  clientOver(Layer.succeed(Socket.Socket, socket), {
    pingInterval: "5 seconds",
    pingTimeout: "10 seconds",
    retryPolicy: Schedule.recurs(0),
  })

export type PipeClient = Effect.Success<ReturnType<typeof connectPipe>>
