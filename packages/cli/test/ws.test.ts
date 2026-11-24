import http from "node:http"

import { BunHttpServer } from "@effect/platform-bun"
import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { PluginLoader } from "@vibest/core/plugin"
import { Project } from "@vibest/core/project"
import * as Platform from "@vibest/platform-bun/bun"
import { makeRepository, testLayer, until } from "@vibest/platform-bun/test/lib/fakes"
import { asEntry, client, served } from "@vibest/platform-bun/test/lib/rpc-helpers"
import {
  CWD_HEADER,
  PLUGIN_VERSION_HEADER,
  PROTOCOL_HEADER,
  SESSION_HEADER,
  TOKEN_HEADER,
} from "@vibest/protocol/protocol"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import * as Ws from "@vibest/server/ws"
import { ConfigProvider, Duration, Effect, Exit, FileSystem, Layer, Option, Predicate, Schema, Scope } from "effect"

const wsDeps = Layer.merge(
  Layer.succeed(
    Ws.WsServerLayer,
    BunHttpServer.layerServer({
      hostname: "127.0.0.1",
      port: 0,
      gracefulShutdownTimeout: Duration.millis(100),
      websocket: {
        maxPayloadLength: 64 * 1024,
        backpressureLimit: 1024 * 1024,
        closeOnBackpressureLimit: true,
      },
    }),
  ),
  Layer.succeed(PluginLoader, Platform.makePluginLoader()),
)

const testProjectBase = () => Project.layer.pipe(Layer.provideMerge(testLayer()))

const servedWithWs = () => {
  const base = served()

  return Layer.merge(Ws.layer.pipe(Layer.provide(wsDeps), Layer.provide(base)), base)
}

const TaggedItem = Schema.Struct({
  _tag: Schema.String,
})

const CauseReason = Schema.Struct({
  _tag: Schema.String,
  error: Schema.optional(TaggedItem),
})

const JsonRpcFrame = Schema.Struct({
  jsonrpc: Schema.String,
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  chunk: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.Array(TaggedItem)),
  error: Schema.optional(
    Schema.Struct({
      _tag: Schema.optional(Schema.String),
      data: Schema.optional(Schema.Unknown),
    }),
  ),
})

const decodeJsonRpcFrame = Schema.decodeUnknownSync(Schema.fromJsonString(JsonRpcFrame))
const decodeCauseReasons = Schema.decodeUnknownOption(Schema.Array(CauseReason))

const rawUpgradeRequest = (port: number, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/",
            method: "GET",
            headers: {
              Upgrade: "websocket",
              Connection: "Upgrade",
              "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
              "Sec-WebSocket-Version": "13",
              ...headers,
            },
          },
          (res) => {
            let body = ""
            res.setEncoding("utf8")
            res.on("data", (chunk: string) => {
              body += chunk
            })
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
          },
        )

        req.on("upgrade", (_res, socket) => {
          socket.destroy()
          resolve({ status: 101, body: "" })
        })
        req.on("error", reject)
        req.end()
      }),
  )

interface WsClient {
  readonly send: (text: string) => Effect.Effect<void>
  readonly nextFrame: (label: string) => Effect.Effect<{ readonly data: unknown }>
  readonly closed: Effect.Effect<number>
}

const connectWs = (url: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const received: Array<{ readonly data: unknown }> = []
    const waiters: Array<(frame: { readonly data: unknown }) => void> = []
    let closeCode: number | undefined
    const closeWaiters: Array<(code: number) => void> = []

    const ws = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(url, { headers })
            socket.addEventListener("message", (event) => {
              const frame = { data: event.data }
              const waiter = waiters.shift()

              if (waiter) waiter(frame)
              else received.push(frame)
            })
            socket.addEventListener("close", (event) => {
              closeCode = event.code

              for (const waiter of closeWaiters.splice(0)) waiter(event.code)
            })
            socket.addEventListener("open", () => resolve(socket), { once: true })
            socket.addEventListener("error", () => reject(new Error("WebSocket handshake failed")), { once: true })
          }),
      ),
      (socket) =>
        Effect.sync(() => {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close()
          }
        }),
    )

    const nextFrame = (label: string): Effect.Effect<{ readonly data: unknown }> =>
      Effect.promise(
        () =>
          new Promise<{ readonly data: unknown }>((resolve, reject) => {
            if (received.length > 0) {
              resolve(received.shift()!)

              return
            }

            const timer = setTimeout(() => reject(new Error(`timed out waiting for WebSocket frame (${label})`)), 3_000)

            waiters.push((frame) => {
              clearTimeout(timer)
              resolve(frame)
            })
          }),
      )

    const closed: Effect.Effect<number> = Effect.promise(
      () =>
        new Promise<number>((resolve, reject) => {
          if (closeCode !== undefined) {
            resolve(closeCode)

            return
          }

          const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket close")), 3_000)

          closeWaiters.push((code) => {
            clearTimeout(timer)
            resolve(code)
          })
        }),
    )

    return {
      send: (text) => Effect.sync(() => ws.send(text)),
      nextFrame,
      closed,
    } satisfies WsClient
  })

const parseTextFrame = (frame: { readonly data: unknown }) => {
  if (!Predicate.isString(frame.data)) {
    assert.fail("expected string WebSocket frame")
  }

  assert.isFalse(frame.data.includes("\n"), `expected single-line JSON-RPC frame, got: ${frame.data}`)

  return decodeJsonRpcFrame(frame.data)
}

describe("local UI WebSocket", () => {
  it.live("exposes WsEndpoint on 127.0.0.1 via Ws.Service when enabled", () =>
    Effect.gen(function* () {
      const info = Option.getOrThrow(yield* Ws.Service)
      assert.strictEqual(info.url, `ws://127.0.0.1:${info.port}`)
      assert.isAbove(info.port, 0)
      assert.match(info.token, /^[a-f0-9]{64}$/)
      assert.strictEqual(info.protocol, PROTOCOL)
    }).pipe(Effect.provide(servedWithWs())),
  )

  it.live("rejects missing or wrong vibest-token with 401 and any Origin header with 403 before upgrade", () =>
    Effect.gen(function* () {
      const info = Option.getOrThrow(yield* Ws.Service)

      const missingToken = yield* rawUpgradeRequest(info.port, {})
      assert.strictEqual(missingToken.status, 401)
      assert.deepStrictEqual(JSON.parse(missingToken.body), { error: "invalid vibest-token" })

      const wrongToken = yield* rawUpgradeRequest(info.port, { [TOKEN_HEADER]: "0".repeat(64) })
      assert.strictEqual(wrongToken.status, 401)
      assert.deepStrictEqual(JSON.parse(wrongToken.body), { error: "invalid vibest-token" })

      const localhostOrigin = yield* rawUpgradeRequest(info.port, {
        [TOKEN_HEADER]: info.token,
        Origin: "http://localhost:3000",
      })

      assert.strictEqual(localhostOrigin.status, 403)
      assert.deepStrictEqual(JSON.parse(localhostOrigin.body), { error: "browser origin refused" })

      const nullOrigin = yield* rawUpgradeRequest(info.port, {
        [TOKEN_HEADER]: info.token,
        Origin: "null",
      })

      assert.strictEqual(nullOrigin.status, 403)
      assert.deepStrictEqual(JSON.parse(nullOrigin.body), { error: "browser origin refused" })
    }).pipe(Effect.provide(servedWithWs())),
  )

  it.live(
    "streams Watch Snapshot and live deltas over raw WebSocket without Ack (with or without trailing newline)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* Db.Service
          const info = Option.getOrThrow(yield* Ws.Service)

          const ws1 = yield* connectWs(info.url, { [TOKEN_HEADER]: info.token })
          yield* ws1.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "1",
              method: "Watch",
              params: {},
              headers: [[PROTOCOL_HEADER, String(PROTOCOL)]],
            }),
          )

          const first = parseTextFrame(yield* ws1.nextFrame("ws1-snapshot"))
          assert.strictEqual(first.jsonrpc, "2.0")
          assert.strictEqual(first.id, "1")
          assert.isTrue(first.chunk)
          assert.isDefined(first.result)
          assert.isTrue(Predicate.isTagged(first.result?.[0], "Snapshot"))

          const repo = yield* makeRepository
          const spawner = yield* asEntry(yield* client, repo)
          const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "watch live" })
          yield* until(
            db.session.getSession(id),
            (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
          )

          let sawDelta = false

          for (let i = 0; i < 10 && !sawDelta; i++) {
            const msg = parseTextFrame(yield* ws1.nextFrame(`ws1-delta-${i}`))
            const items = msg.result

            if (
              items !== undefined &&
              items.some((item) => Predicate.isTagged(item, "Session") || Predicate.isTagged(item, "Project"))
            ) {
              sawDelta = true
            }
          }

          assert.isTrue(sawDelta, "expected live Project or Session delta without sending Ack")

          const ws2 = yield* connectWs(info.url, {
            [TOKEN_HEADER]: info.token,
            [PROTOCOL_HEADER]: String(PROTOCOL),
          })

          yield* ws2.send(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: "2",
              method: "Watch",
              params: {},
            })}\n`,
          )

          const second = parseTextFrame(yield* ws2.nextFrame("ws2-snapshot"))
          assert.strictEqual(second.id, "2")
          assert.isTrue(second.chunk)
          assert.isTrue(Predicate.isTagged(second.result?.[0], "Snapshot"))
        }),
      ).pipe(Effect.provide(servedWithWs())),
  )

  it.live("forbids both scoped and non-scoped non-allowlisted RPC methods over the local WebSocket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const info = Option.getOrThrow(yield* Ws.Service)
        const ws = yield* connectWs(info.url, { [TOKEN_HEADER]: info.token })

        const forbiddenCalls: ReadonlyArray<{
          readonly id: string
          readonly method: string
          readonly params: unknown
        }> = [
          { id: "10", method: "List", params: {} },
          { id: "11", method: "Daemon.Stop", params: { instance: "x" } },
          { id: "12", method: "Session.Seen", params: { id: "x", finished: 0 } },
          { id: "13", method: "Ping", params: null },
          { id: "14", method: "ExecutionEnd", params: { sessionId: "x", harness: "pi", event: "{}" } },
          { id: "15", method: "Prompt", params: { sessionId: "x", harness: "pi", event: "{}" } },
          { id: "16", method: "Republish", params: null },
        ]

        for (const call of forbiddenCalls) {
          yield* ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: call.id,
              method: call.method,
              params: call.params,
              headers: [[PROTOCOL_HEADER, String(PROTOCOL)]],
            }),
          )

          const msg = parseTextFrame(yield* ws.nextFrame(`forbidden-${call.method}`))
          assert.strictEqual(msg.id, call.id)

          const reasons = decodeCauseReasons(msg.error?.data)
          const firstReason = Option.isSome(reasons) ? reasons.value[0] : undefined
          assert.isTrue(Predicate.isTagged(firstReason, "Fail"), `expected Fail cause for ${call.method}`)
          assert.isTrue(Predicate.isTagged(firstReason?.error, "Forbidden"), `expected Forbidden for ${call.method}`)
        }
      }),
    ).pipe(Effect.provide(servedWithWs())),
  )

  it.live(
    "strips non-protocol headers and never mutates session integration state or crashes on malformed vibest-cwd",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* Db.Service
          const info = Option.getOrThrow(yield* Ws.Service)

          const repo = yield* makeRepository
          const spawner = yield* asEntry(yield* client, repo)
          const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "spoof check" })
          yield* until(
            db.session.getSession(id),
            (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
          )

          const beforeIntegration = (yield* db.session.getSession(id))?.process?.integration

          const ws = yield* connectWs(info.url, {
            [TOKEN_HEADER]: info.token,
            [PROTOCOL_HEADER]: String(PROTOCOL),
            [SESSION_HEADER]: id,
            [PLUGIN_VERSION_HEADER]: "9.9.9-spoofed",
            [CWD_HEADER]: "%ZZ",
          })

          yield* ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "spoof-1",
              method: "Watch",
              params: {},
              headers: [
                [PROTOCOL_HEADER, String(PROTOCOL)],
                [SESSION_HEADER, id],
                [PLUGIN_VERSION_HEADER, "9.9.9-spoofed"],
                [CWD_HEADER, "%ZZ"],
              ],
            }),
          )

          const first = parseTextFrame(yield* ws.nextFrame("spoof-snapshot"))
          assert.strictEqual(first.id, "spoof-1")
          assert.isTrue(Predicate.isTagged(first.result?.[0], "Snapshot"))

          const afterIntegration = (yield* db.session.getSession(id))?.process?.integration
          assert.deepStrictEqual(afterIntegration, beforeIntegration)
        }),
      ).pipe(Effect.provide(servedWithWs())),
  )

  it.live("rejects JSON-RPC batch arrays and closes oversized frames", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const info = Option.getOrThrow(yield* Ws.Service)

        const ws = yield* connectWs(info.url, {
          [TOKEN_HEADER]: info.token,
          [PROTOCOL_HEADER]: String(PROTOCOL),
        })

        yield* ws.send(
          JSON.stringify([
            { jsonrpc: "2.0", id: "b1", method: "Watch", params: {} },
            { jsonrpc: "2.0", id: "b2", method: "List", params: {} },
          ]),
        )

        const batchErr = parseTextFrame(yield* ws.nextFrame("batch-error"))
        assert.strictEqual(batchErr.error?._tag, "Defect")

        yield* ws.send("x".repeat(70 * 1024))
        const code = yield* ws.closed
        assert.isTrue(code === 1009 || code === 1006, `expected oversized frame close code, got ${code}`)
      }),
    ).pipe(Effect.provide(servedWithWs())),
  )

  it.live("returns Option.none() when disabled via vibest.json", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const ctx = yield* Layer.buildWithScope(testProjectBase(), scope)
      const layout = yield* Effect.provide(Layout, ctx)
      const fsSvc = yield* Effect.provide(FileSystem.FileSystem, ctx)

      yield* fsSvc.writeFileString(layout.config, JSON.stringify({ websocket: false }))

      const wsScope = yield* Scope.make()
      const wsCtx = yield* Layer.buildWithScope(Ws.layer.pipe(Layer.provide(wsDeps)), wsScope).pipe(Effect.provide(ctx))
      const endpoint = yield* Effect.provide(Ws.Service, wsCtx)

      assert.isTrue(Option.isNone(endpoint))
      yield* Scope.close(wsScope, Exit.void)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live("returns Option.none() when disabled via VIBEST_WEBSOCKET=0", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const ctx = yield* Layer.buildWithScope(testProjectBase(), scope)

      const wsScope = yield* Scope.make()

      const wsCtx = yield* Layer.buildWithScope(
        Ws.layer.pipe(
          Layer.provide(wsDeps),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ VIBEST_WEBSOCKET: "0" }))),
        ),
        wsScope,
      ).pipe(Effect.provide(ctx))

      const endpoint = yield* Effect.provide(Ws.Service, wsCtx)

      assert.isTrue(Option.isNone(endpoint))
      yield* Scope.close(wsScope, Exit.void)
      yield* Scope.close(scope, Exit.void)
    }),
  )
})
