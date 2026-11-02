// Wire behaviour against a fake herdr on a temp unix socket; no herdr needed.
import { assert, layer } from "@effect/vitest"
import { BunServices, BunSocketServer } from "@effect/platform-bun"
import { Cause, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as HerdrBun from "../src/bun.js"
import { type EventFrame, Herdr, HerdrProtocolMismatch, HerdrTransportError, PROTOCOL, type results } from "../src/index.js"

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ id: Schema.String, method: Schema.String })))
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const closed = (pane_id: string): EventFrame => ({ event: "pane_closed", data: { type: "pane_closed", pane_id, workspace_id: "w1" } })

// One request per connection, like herdr. `agent.get` errors, `events.subscribe` acks then pushes two frames and closes.
const fakeHerdr = (protocol: number) => (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const pull = yield* Socket.readerString(socket)
    const writer = yield* socket.writer
    const line = yield* Stream.fromPull(Effect.succeed(pull.pipe(Effect.catchIf((e) => e.reason._tag === "SocketCloseError", () => Cause.done())))).pipe(
      Stream.splitLines,
      Stream.runHead,
    )
    const request = yield* decodeRequest(Option.getOrElse(line, () => ""))
    const send = (o: object) => encodeLine(o).pipe(Effect.flatMap((json) => writer.write(`${json}\n`)))
    if (request.method === "ping") yield* send({ id: request.id, result: { type: "pong", protocol, version: "test" } satisfies results.Result_pong })
    else if (request.method === "agent.get") yield* send({ id: request.id, error: { code: "agent_not_found", message: "nope" } })
    else if (request.method === "events.subscribe") {
      yield* send({ id: request.id, result: { type: "subscription_started" } })
      yield* send(closed("w1:p1"))
      yield* send(closed("w1:p2"))
    }
    yield* writer.write(new Socket.CloseEvent())
  }).pipe(Effect.scoped, Effect.orDie)

/** A fresh fake herdr in a temp dir, torn down with the test's scope. */
const fakeServer = (protocol: number = PROTOCOL) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-herdr-" })
  const socketPath = path.join(dir, "herdr.sock")
  const server = yield* BunSocketServer.make({ path: socketPath })
  yield* Effect.forkScoped(server.run(fakeHerdr(protocol)))
  return { herdr: yield* Herdr.make(socketPath), dir }
})

layer(Layer.mergeAll(BunServices.layer, HerdrBun.layer))("Herdr client", (it) => {
  it.effect("call returns the result", () =>
    Effect.gen(function* () {
      const { herdr } = yield* fakeServer()
      const pong = yield* herdr.call("ping", {})
      assert.strictEqual(pong.type, "pong")
      assert.strictEqual(pong.protocol, 22)
    }))

  it.effect("server error is a HerdrError with its code", () =>
    Effect.gen(function* () {
      const { herdr } = yield* fakeServer()
      const e = yield* Effect.flip(herdr.call("agent.get", { target: "x" }))
      assert.strictEqual(e._tag, "HerdrError")
      if (e._tag === "HerdrError") assert.strictEqual(e.code, "agent_not_found")
    }))

  it.effect("missing socket is a HerdrTransportError", () =>
    Effect.gen(function* () {
      const { dir } = yield* fakeServer()
      const absent = yield* Herdr.make(`${dir}/absent.sock`)
      assert.instanceOf(yield* Effect.flip(absent.call("ping", {})), HerdrTransportError)
    }))

  it.effect("subscribe skips the ack, yields frames, ends on close", () =>
    Effect.gen(function* () {
      const { herdr } = yield* fakeServer()
      const frames = yield* Stream.runCollect(herdr.subscribe([{ type: "pane.closed" }]))
      assert.deepStrictEqual(
        Array.from(frames).map((f) => ("type" in f.data && f.data.type === "pane_closed" ? f.data.pane_id : f.event)),
        ["w1:p1", "w1:p2"],
      )
    }))

  it.effect("verifyProtocol accepts the generated protocol and refuses another", () =>
    Effect.gen(function* () {
      yield* Herdr.verifyProtocol((yield* fakeServer()).herdr)
      const e = yield* Effect.flip(Herdr.verifyProtocol((yield* fakeServer(PROTOCOL + 1)).herdr))
      assert.instanceOf(e, HerdrProtocolMismatch)
      assert.deepInclude(e, { expected: PROTOCOL, actual: PROTOCOL + 1, serverVersion: "test" })
    }))
})
