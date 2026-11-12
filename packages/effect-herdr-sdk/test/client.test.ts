import { BunServices, BunSocketServer } from "@effect/platform-bun"
import { assert, layer } from "@effect/vitest"
import { Cause, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"

import * as HerdrBun from "../src/bun.js"
import { type EventFrame, Herdr, HerdrProtocolMismatch, PROTOCOL, type results } from "../src/index.js"

const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, method: Schema.String })),
)
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const closed = (pane_id: string): EventFrame => ({
  event: "pane_closed",
  data: { type: "pane_closed", pane_id, workspace_id: "w1" },
})

const fakeHerdr = (protocol: number) => (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const pull = yield* Socket.readerString(socket)
    const writer = yield* socket.writer
    const line = yield* Stream.fromPull(
      Effect.succeed(
        pull.pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "SocketCloseError",
            () => Cause.done(),
          ),
        ),
      ),
    ).pipe(Stream.splitLines, Stream.runHead)
    const request = yield* decodeRequest(Option.getOrElse(line, () => ""))
    const send = (o: object) => encodeLine(o).pipe(Effect.flatMap((json) => writer.write(`${json}\n`)))
    if (request.method === "ping")
      yield* send({ id: request.id, result: { type: "pong", protocol, version: "test" } satisfies results.Result_pong })
    else if (request.method === "agent.get")
      yield* send({ id: request.id, error: { code: "agent_not_found", message: "nope" } })
    else if (request.method === "events.subscribe") {
      yield* send({ id: request.id, result: { type: "subscription_started" } })
      yield* send(closed("w1:p1"))
      yield* send(closed("w1:p2"))
    }
    yield* writer.write(new Socket.CloseEvent())
  }).pipe(Effect.scoped, Effect.orDie)

const fakeServer = (protocol: number = PROTOCOL) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-herdr-" })
    const socketPath = path.join(dir, "herdr.sock")
    const server = yield* BunSocketServer.make({ path: socketPath })
    yield* Effect.forkScoped(server.run(fakeHerdr(protocol)))
    return { herdr: yield* Herdr.make(socketPath), dir }
  })

layer(Layer.mergeAll(BunServices.layer, HerdrBun.layer))("Herdr client", (it) => {
  it.effect("verifyProtocol accepts the generated protocol and refuses another", () =>
    Effect.gen(function* () {
      yield* Herdr.verifyProtocol((yield* fakeServer()).herdr)
      const e = yield* Effect.flip(Herdr.verifyProtocol((yield* fakeServer(PROTOCOL + 1)).herdr))
      assert.instanceOf(e, HerdrProtocolMismatch)
      assert.deepInclude(e, { expected: PROTOCOL, actual: PROTOCOL + 1, serverVersion: "test" })
    }),
  )
})
