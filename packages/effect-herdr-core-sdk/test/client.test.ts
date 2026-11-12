import { BunServices, BunSocketServer } from "@effect/platform-bun"
import { assert, layer } from "@effect/vitest"
import { Cause, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"

import * as HcBun from "../src/bun.js"
import {
  Hc,
  HcCoreTooOld,
  HcGenerationMismatch,
  HcMethodsMissing,
  HcTransportError,
  USED_METHODS,
} from "../src/index.js"

interface Core {
  readonly generation: number
  readonly version: string
  readonly methods: ReadonlyArray<string>
}

const CURRENT: Core = { generation: 1, version: "0.1.13", methods: ["hello", ...USED_METHODS] }

const recorded = (core: Core, sent?: number): Record<string, ReadonlyArray<string>> => ({
  hello:
    sent !== undefined && sent !== core.generation
      ? [
          `{"error":{"code":-32000,"data":{"hint":"this core speaks generation ${core.generation}","kind":"unsupported_generation"},"message":"protocol generation ${sent} not supported"},"id":ID,"jsonrpc":"2.0"}`,
        ]
      : [
          `{"id":ID,"jsonrpc":"2.0","result":{"core":{"id":"5d09","name":"mac-mini"},"features":["framed","attach","events","status","shell"],"framed":false,"generation":${core.generation},"methods":${JSON.stringify(core.methods)},"version":${JSON.stringify(core.version)}}}`,
        ],
  "terminal.read": ['{"id":ID,"jsonrpc":"2.0","result":{"complete":"yes"}}'],
})

const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      method: Schema.String,
      jsonrpc: Schema.Literal("2.0"),
      params: Schema.optional(Schema.Struct({ generation: Schema.optional(Schema.Number) })),
    }),
  ),
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
    for (const reply of recorded(core, request.params?.generation)[request.method] ?? [])
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
  it.effect("a result that does not match the schema is a transport error, not a wrong value", () =>
    Effect.gen(function* () {
      const { hc } = yield* fakeServer()
      assert.instanceOf(yield* Effect.flip(hc.call("terminal.read", { terminal: "t1" })), HcTransportError)
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
})
