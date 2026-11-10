import { VibestRpcs } from "@vibest/protocol/rpc"
import { Duration, Effect, Layer, Predicate, Schedule } from "effect"
import { RpcClient, RpcClientError, RpcMessage, RpcSerialization } from "effect/rpc"
import * as Socket from "effect/socket/Socket"

export const stdioSocket = (streams: Socket.InputTransformStream) => Socket.fromTransformStream(Effect.succeed(streams))

const serialization = RpcSerialization.ndJsonRpc()

export const PING_TIMEOUT = Duration.seconds(10)

export const connectPipe = (socket: Socket.Socket) =>
  Layer.build(
    RpcClient.layerProtocolSocket({
      pingInterval: "5 seconds",
      pingTimeout: PING_TIMEOUT,
      retryPolicy: Schedule.recurs(0),
    }).pipe(
      Layer.provide(Layer.succeed(Socket.Socket, socket)),
      Layer.provide(Layer.succeed(RpcSerialization.RpcSerialization, serialization)),
    ),
  ).pipe(Effect.flatMap((protocol) => RpcClient.make(VibestRpcs).pipe(Effect.provide(protocol))))

export type PipeClient = Effect.Success<ReturnType<typeof connectPipe>>

export const firstAnswer = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    yield* writer.write(serialization.makeUnsafe().encode(RpcMessage.constPing)!)
    let held: Effect.Success<typeof reader.pull> | undefined = yield* reader.pull
    return Socket.make({
      reader: Effect.succeed({
        pull: Effect.suspend(() => {
          const replay = held
          held = undefined
          return replay === undefined ? reader.pull : Effect.succeed(replay)
        }),
        upgrade: reader.upgrade,
      }),
      writer: Effect.succeed(writer),
    })
  })

export const pingTimedOut = (e: unknown) =>
  e instanceof RpcClientError.RpcClientError &&
  e.reason._tag === "SocketReadError" &&
  Predicate.isError(e.reason.cause) &&
  e.reason.cause.message === "ping timeout"
