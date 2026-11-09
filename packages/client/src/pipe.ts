import { VibestRpcs } from "@vibest/protocol/rpc"
import { Effect, Layer, Schedule } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import * as Socket from "effect/socket/Socket"

export const stdioSocket = (streams: Socket.InputTransformStream) => Socket.fromTransformStream(Effect.succeed(streams))

export const connectPipe = (socket: Socket.Socket) =>
  Layer.build(
    RpcClient.layerProtocolSocket({
      pingInterval: "5 seconds",
      pingTimeout: "10 seconds",
      retryPolicy: Schedule.recurs(0),
    }).pipe(Layer.provide(Layer.succeed(Socket.Socket, socket)), Layer.provide(RpcSerialization.layerNdJsonRpc())),
  ).pipe(Effect.flatMap((protocol) => RpcClient.make(VibestRpcs).pipe(Effect.provide(protocol))))

export type PipeClient = Effect.Success<ReturnType<typeof connectPipe>>
