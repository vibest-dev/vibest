import { BunServices, BunSocketServer } from "@effect/platform-bun"
import { assert, layer } from "@effect/vitest"
import { Cause, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"

import * as HcBun from "../src/bun.js"
import {
  Hc,
  HcCoreTooOld,
  HcError,
  HcGenerationMismatch,
  HcMethodsMissing,
  HcTransportError,
  USED_METHODS,
} from "../src/index.js"

const RECORDED_TERMINAL =
  '{"address":"t1","argv":["sh"],"cols":200,"created_ms":1793929163810,"cwd":"/tmp","die_with_parent":false,"exit_code":null,"finished_ms":null,"identity":"ghostty","keep":true,"labels":{"vibest.runtime":"hc"},"name":"probe1","notify":false,"parent":null,"pid":26170,"reason":null,"reported":false,"rm":false,"rows":120,"screen":"exact","signal":null,"state":"live","status":null,"status_ms":null,"template":null,"title":"","turn":0}'

interface Core {
  readonly generation: number
  readonly version: string
  readonly methods: ReadonlyArray<string>
}

const CURRENT: Core = { generation: 1, version: "0.1.13", methods: ["hello", ...USED_METHODS] }

const recorded = (core: Core): Record<string, ReadonlyArray<string>> => ({
  hello:
    core.generation === 2
      ? [
          '{"error":{"code":-32000,"data":{"hint":"this core speaks generation 2","kind":"unsupported_generation"},"message":"protocol generation 1 not supported"},"id":ID,"jsonrpc":"2.0"}',
        ]
      : [
          `{"id":ID,"jsonrpc":"2.0","result":{"core":{"id":"5d09","name":"mac-mini"},"features":["framed","attach","events","status","shell"],"framed":false,"generation":${core.generation},"methods":${JSON.stringify(core.methods)},"version":${JSON.stringify(core.version)}}}`,
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

const fakeCore = (core: Core) => (socket: Socket.Socket) =>
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
    for (const reply of recorded(core)[request.method] ?? [])
      yield* writer.write(`${reply.replace("ID", String(request.id))}\n`)
    yield* writer.write(new Socket.CloseEvent())
  }).pipe(Effect.scoped, Effect.orDie)

const fakeServer = (core: Core = CURRENT) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-hc-" })
    const socketPath = path.join(dir, "hc.sock")
    const server = yield* BunSocketServer.make({ path: socketPath })
    yield* Effect.forkScoped(server.run(fakeCore(core)))
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

  it.effect("hello accepts the same generation at the minimum or a newer version", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* (yield* fakeServer()).hc.hello).version, "0.1.13")
      assert.strictEqual((yield* (yield* fakeServer({ ...CURRENT, version: "0.1.18" })).hc.hello).version, "0.1.18")
      assert.strictEqual((yield* (yield* fakeServer({ ...CURRENT, version: "0.10.0" })).hc.hello).version, "0.10.0")
    }),
  )

  it.effect("hello refuses an older version, saying to update herdr-core", () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip((yield* fakeServer({ ...CURRENT, version: "hc 0.1.12" })).hc.hello)
      assert.instanceOf(e, HcCoreTooOld)
      assert.deepInclude(e, { version: "hc 0.1.12", minimum: "0.1.13" })
      assert.include(e.message, "update herdr-core")
      assert.include(e.message, "0.1.13")
    }),
  )

  it.effect("hello refuses a newer generation, saying to update vibest", () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip((yield* fakeServer({ ...CURRENT, generation: 2 })).hc.hello)
      assert.instanceOf(e, HcGenerationMismatch)
      assert.strictEqual(e.expected, 1)
      assert.include(e.message, "update vibest")
      const reported = yield* Effect.flip((yield* fakeServer({ ...CURRENT, generation: 3, version: "9.0.0" })).hc.hello)
      assert.instanceOf(reported, HcGenerationMismatch)
    }),
  )

  it.effect("hello refuses an older generation, saying to update herdr-core", () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip((yield* fakeServer({ ...CURRENT, generation: 0 })).hc.hello)
      assert.instanceOf(e, HcGenerationMismatch)
      assert.include(e.message, "update herdr-core")
    }),
  )

  it.effect("hello refuses a core without a method vibest calls, naming it", () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(
        (yield* fakeServer({ ...CURRENT, methods: ["hello", ...USED_METHODS.filter((m) => m !== "terminal.label")] }))
          .hc.hello,
      )
      assert.instanceOf(e, HcMethodsMissing)
      assert.deepStrictEqual(e.missing, ["terminal.label"])
      assert.include(e.message, "update herdr-core")
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
