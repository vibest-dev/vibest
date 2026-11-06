import { BunServices, BunSocketServer } from "@effect/platform-bun"
import { assert, layer } from "@effect/vitest"
import { Cause, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"

import * as HcBun from "../src/bun.js"
import { Hc, HcError, HcGenerationMismatch, HcTransportError } from "../src/index.js"

const RECORDED_TERMINAL =
  '{"address":"t1","argv":["sh"],"cols":200,"created_ms":1793929163810,"cwd":"/tmp","die_with_parent":false,"exit_code":null,"finished_ms":null,"identity":"ghostty","keep":true,"labels":{"vibest.runtime":"hc"},"name":"probe1","notify":false,"parent":null,"pid":26170,"reason":null,"reported":false,"rm":false,"rows":120,"screen":"exact","signal":null,"state":"live","status":null,"status_ms":null,"template":null,"title":"","turn":0}'

const recorded = (generation: number): Record<string, ReadonlyArray<string>> => ({
  hello:
    generation === 1
      ? [
          '{"id":ID,"jsonrpc":"2.0","result":{"core":{"id":"5d09","name":"mac-mini"},"features":["framed","attach","events","status","shell"],"framed":false,"generation":1,"methods":["hello"],"version":"0.1.13"}}',
        ]
      : [
          '{"error":{"code":-32000,"data":{"hint":"this core speaks generation 2","kind":"unsupported_generation"},"message":"protocol generation 1 not supported"},"id":ID,"jsonrpc":"2.0"}',
        ],
  "terminal.get": [`{"id":ID,"jsonrpc":"2.0","result":${RECORDED_TERMINAL}}`],
  "terminal.kill": [
    '{"error":{"code":-32000,"data":{"hint":"see `hc ls --all`","kind":"not_found"},"message":"no terminal \\"t99\\""},"id":ID,"jsonrpc":"2.0"}',
  ],
  "terminal.read": ['{"id":ID,"jsonrpc":"2.0","result":{"complete":"yes"}}'],
  "events.subscribe": [
    '{"id":ID,"jsonrpc":"2.0","result":{"channel":null,"seq":0,"terminals":[]}}',
    `{"jsonrpc":"2.0","method":"event","params":{"data":${RECORDED_TERMINAL},"seq":1,"terminal":"t1","type":"created"}}`,
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"argv":["sh"],"cwd":"/private/tmp","name":"bash","pid":26170},"seq":2,"terminal":"t1","type":"foreground"}}',
    '{"jsonrpc":"2.0","method":"heartbeat","params":{}}',
  ],
})

const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number, method: Schema.String, jsonrpc: Schema.Literal("2.0") })),
)

const fakeCore = (generation: number) => (socket: Socket.Socket) =>
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
    for (const reply of recorded(generation)[request.method] ?? [])
      yield* writer.write(`${reply.replace("ID", String(request.id))}\n`)
    yield* writer.write(new Socket.CloseEvent())
  }).pipe(Effect.scoped, Effect.orDie)

const fakeServer = (generation = 1) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-hc-" })
    const socketPath = path.join(dir, "hc.sock")
    const server = yield* BunSocketServer.make({ path: socketPath })
    yield* Effect.forkScoped(server.run(fakeCore(generation)))
    return { hc: yield* Hc.make(socketPath), dir }
  })

layer(Layer.mergeAll(BunServices.layer, HcBun.layer))("Hc client", (it) => {
  it.effect("call decodes the result with the generated schema", () =>
    Effect.gen(function* () {
      const { hc } = yield* fakeServer()
      const terminal = yield* hc.call("terminal.get", { terminal: "t1" })
      assert.strictEqual(terminal.address, "t1")
      assert.deepStrictEqual(terminal.labels, { "vibest.runtime": "hc" })
      assert.strictEqual(terminal.state, "live")
    }),
  )

  it.effect("a server error is an HcError carrying data.kind and the hint", () =>
    Effect.gen(function* () {
      const { hc } = yield* fakeServer()
      const e = yield* Effect.flip(hc.call("terminal.kill", { terminal: "t99" }))
      assert.instanceOf(e, HcError)
      assert.deepInclude(e, { method: "terminal.kill", kind: "not_found", hint: "see `hc ls --all`" })
    }),
  )

  it.effect("a result that does not match the schema is a transport error, not a wrong value", () =>
    Effect.gen(function* () {
      const { hc } = yield* fakeServer()
      assert.instanceOf(yield* Effect.flip(hc.call("terminal.read", { terminal: "t1" })), HcTransportError)
    }),
  )

  it.effect("a missing socket is an HcTransportError", () =>
    Effect.gen(function* () {
      const { dir } = yield* fakeServer()
      const absent = yield* Hc.make(`${dir}/absent.sock`)
      assert.instanceOf(yield* Effect.flip(absent.call("terminal.get", { terminal: "t1" })), HcTransportError)
    }),
  )

  it.effect("hello accepts the pinned generation and refuses another", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* (yield* fakeServer()).hc.hello).version, "0.1.13")
      const e = yield* Effect.flip((yield* fakeServer(2)).hc.hello)
      assert.instanceOf(e, HcGenerationMismatch)
      assert.strictEqual(e.expected, 1)
    }),
  )

  it.effect("subscribe yields the snapshot, then events and other notifications in order, and ends on close", () =>
    Effect.gen(function* () {
      const { hc } = yield* fakeServer()
      const notices = Array.from(yield* Stream.runCollect(hc.subscribe({ labels: { "vibest.runtime": "hc" } })))
      assert.deepStrictEqual(
        notices.map((n) => (n._tag === "Event" ? `${n.event.type}:${n.event.terminal}` : n._tag)),
        ["Subscribed", "created:t1", "foreground:t1", "Notification"],
      )
    }),
  )
})
