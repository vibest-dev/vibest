import http from "node:http"

import { BunHttpServer } from "@effect/platform-bun"
import { assert, describe, it } from "@effect/vitest"
import { PluginLoader } from "@vibest/core/plugin"
import { Project } from "@vibest/core/project"
import { SessionStore } from "@vibest/core/session/store"
import {
  CWD_HEADER,
  PLUGIN_VERSION_HEADER,
  PROTOCOL_HEADER,
  SESSION_HEADER,
  TOKEN_HEADER,
} from "@vibest/protocol/protocol"
import { EdgeMutual } from "@vibest/protocol/schemas"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import * as Ui from "@vibest/server/ui"
import { makeRepository, testLayer, until } from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { asEntry, client, served } from "@vibest/testkit/rpc-helpers"
import { ConfigProvider, Duration, Effect, Exit, FileSystem, Layer, Option, Predicate, Schema, Scope } from "effect"

const uiDeps = Layer.merge(
  Layer.succeed(
    Ui.UiServerLayer,
    BunHttpServer.layerServer({
      hostname: "127.0.0.1",
      port: 0,
      gracefulShutdownTimeout: Duration.millis(100),
    }),
  ),
  Layer.succeed(PluginLoader, Platform.makePluginLoader()),
)

const testProjectBase = () => Project.layer.pipe(Layer.provideMerge(testLayer()))

const servedWithUi = () => {
  const base = served()

  return Layer.merge(Ui.layer.pipe(Layer.provide(uiDeps), Layer.provide(base)), base)
}

type RequestBody = Schema.JsonObject | { readonly spec: typeof EdgeMutual.Type }

const httpReq = (port: number, method: string, path: string, headers: Record<string, string>, body?: RequestBody) =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
        const text = body === undefined ? undefined : JSON.stringify(body)

        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method,
            headers: {
              ...(text !== undefined && { "content-type": "application/json" }),
              ...headers,
            },
          },
          (res) => {
            let out = ""
            res.setEncoding("utf8")
            res.on("data", (chunk: string) => {
              out += chunk
            })
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }))
          },
        )

        req.on("error", reject)

        if (text !== undefined) req.write(text)
        req.end()
      }),
  )

const openSse = (port: number, path: string, headers: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          readonly nextEvent: (label: string) => Effect.Effect<unknown>
          readonly close: () => void
        }>((resolve, reject) => {
          const events: Array<Schema.Json> = []
          const waiters: Array<(ev: Schema.Json) => void> = []
          let buf = ""

          const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
            if ((res.statusCode ?? 0) !== 200) {
              reject(new Error(`SSE status ${res.statusCode}`))

              return
            }

            res.setEncoding("utf8")
            res.on("data", (chunk: string) => {
              buf += chunk

              for (;;) {
                const idx = buf.indexOf("\n\n")

                if (idx === -1) break
                const block = buf.slice(0, idx)
                buf = buf.slice(idx + 2)

                for (const line of block.split("\n")) {
                  if (!line.startsWith("data:")) continue
                  const data = JSON.parse(line.slice(5).trim())
                  const waiter = waiters.shift()

                  if (waiter) waiter(data)
                  else events.push(data)
                }
              }
            })

            const nextEvent = (label: string) =>
              Effect.promise(
                () =>
                  new Promise<unknown>((resEv, rejEv) => {
                    if (events.length > 0) {
                      resEv(events.shift()!)

                      return
                    }

                    const timer = setTimeout(() => rejEv(new Error(`timed out waiting for SSE (${label})`)), 3_000)

                    waiters.push((ev) => {
                      clearTimeout(timer)
                      resEv(ev)
                    })
                  }),
              )

            resolve({
              nextEvent,
              close: () => {
                req.destroy()
                res.destroy()
              },
            })
          })

          req.on("error", reject)
          req.end()
        }),
    ),
    (s) => Effect.sync(s.close),
  )

describe("local UI HTTP+SSE server", () => {
  it.live("exposes UiEndpoint on 127.0.0.1 via Ui.Service when enabled", () =>
    Effect.gen(function* () {
      const info = Option.getOrThrow(yield* Ui.Service)
      assert.strictEqual(info.url, `http://127.0.0.1:${info.port}`)
      assert.isAbove(info.port, 0)
      assert.match(info.token, /^[a-f0-9]{64}$/)
      assert.strictEqual(info.protocol, PROTOCOL)
    }).pipe(Effect.provide(servedWithUi())),
  )

  it.live("rejects missing or wrong vibest-token with 401 and any Origin header with 403", () =>
    Effect.gen(function* () {
      const info = Option.getOrThrow(yield* Ui.Service)

      const missingToken = yield* httpReq(info.port, "GET", "/api/machine", { [PROTOCOL_HEADER]: String(PROTOCOL) })
      assert.strictEqual(missingToken.status, 401)

      const wrongToken = yield* httpReq(info.port, "GET", "/api/machine", {
        [TOKEN_HEADER]: "0".repeat(64),
        [PROTOCOL_HEADER]: String(PROTOCOL),
      })

      assert.strictEqual(wrongToken.status, 401)

      const localhostOrigin = yield* httpReq(info.port, "GET", "/api/machine", {
        [TOKEN_HEADER]: info.token,
        [PROTOCOL_HEADER]: String(PROTOCOL),
        Origin: "http://localhost:3000",
      })

      assert.strictEqual(localhostOrigin.status, 403)
      assert.deepStrictEqual(JSON.parse(localhostOrigin.body), { error: "browser origin refused" })

      const nullOrigin = yield* httpReq(info.port, "GET", "/api/machine", {
        [TOKEN_HEADER]: info.token,
        [PROTOCOL_HEADER]: String(PROTOCOL),
        Origin: "null",
      })

      assert.strictEqual(nullOrigin.status, 403)
    }).pipe(Effect.provide(servedWithUi())),
  )

  it.live("streams Watch Snapshot and live deltas over SSE", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessionStore = yield* SessionStore.Service
        const info = Option.getOrThrow(yield* Ui.Service)

        const sse = yield* openSse(info.port, "/api/watch", {
          [TOKEN_HEADER]: info.token,
          [PROTOCOL_HEADER]: String(PROTOCOL),
        })

        const first = yield* sse.nextEvent("snapshot")
        assert.isTrue(Predicate.isTagged(first, "Snapshot"))

        const repo = yield* makeRepository
        const spawner = yield* asEntry(yield* client, repo)

        const { id } = yield* spawner["server.session"]["session.spawn"]({
          payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "watch live" },
        })

        yield* until(
          sessionStore.getSession(id),
          (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
        )

        let sawDelta = false

        for (let i = 0; i < 10 && !sawDelta; i++) {
          const ev = yield* sse.nextEvent(`delta-${i}`)

          if (Predicate.isTagged(ev, "Session") || Predicate.isTagged(ev, "Project")) sawDelta = true
        }

        assert.isTrue(sawDelta, "expected live Project or Session delta over SSE")
      }),
    ).pipe(Effect.provide(servedWithUi())),
  )

  it.live("forbids non-allowlisted endpoints over the local UI HTTP server", () =>
    Effect.gen(function* () {
      const info = Option.getOrThrow(yield* Ui.Service)

      const headers = {
        [TOKEN_HEADER]: info.token,
        [PROTOCOL_HEADER]: String(PROTOCOL),
      }

      const forbidden: ReadonlyArray<readonly [string, string, RequestBody?]> = [
        ["GET", "/api/session"],
        ["POST", "/api/daemon/stop", { instance: "x" }],
        ["POST", "/api/session/spawn", { agent: "general", prompt: "x", callerEnv: {} }],
        ["GET", "/api/daemon/ping"],
        ["POST", "/api/daemon/republish"],
        ["POST", "/api/session/claim", { agent: "coordinator", fresh: false, terminal: { id: "t1" } }],
      ]

      for (const [method, path, body] of forbidden) {
        const res = yield* httpReq(info.port, method, path, headers, body)
        assert.strictEqual(res.status, 403, `${method} ${path} should be 403`)
      }
    }).pipe(Effect.provide(servedWithUi())),
  )

  it.live("strips non-protocol headers and never mutates session integration state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessionStore = yield* SessionStore.Service
        const info = Option.getOrThrow(yield* Ui.Service)

        const repo = yield* makeRepository
        const spawner = yield* asEntry(yield* client, repo)

        const { id } = yield* spawner["server.session"]["session.spawn"]({
          payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "spoof check" },
        })

        yield* until(
          sessionStore.getSession(id),
          (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
        )

        const beforeIntegration = (yield* sessionStore.getSession(id))?.process?.integration

        const sse = yield* openSse(info.port, "/api/watch", {
          [TOKEN_HEADER]: info.token,
          [PROTOCOL_HEADER]: String(PROTOCOL),
          [SESSION_HEADER]: id,
          [PLUGIN_VERSION_HEADER]: "9.9.9-spoofed",
          [CWD_HEADER]: "%ZZ",
        })

        const first = yield* sse.nextEvent("spoof-snapshot")
        assert.isTrue(Predicate.isTagged(first, "Snapshot"))

        const afterIntegration = (yield* sessionStore.getSession(id))?.process?.integration
        assert.deepStrictEqual(afterIntegration, beforeIntegration)
      }),
    ).pipe(Effect.provide(servedWithUi())),
  )

  it.live("allows UI control endpoints over local HTTP", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const info = Option.getOrThrow(yield* Ui.Service)
        const repo = yield* makeRepository

        const headers = {
          [TOKEN_HEADER]: info.token,
          [PROTOCOL_HEADER]: String(PROTOCOL),
        }

        const call = (method: string, path: string, body?: RequestBody) =>
          httpReq(info.port, method, path, headers, body).pipe(
            Effect.map((r) => {
              assert.isTrue(r.status >= 200 && r.status < 300, `${method} ${path} failed (${r.status}): ${r.body}`)

              return r.body === "" ? undefined : JSON.parse(r.body)
            }),
          )

        assert.isArray(yield* call("GET", "/api/machine"))
        assert.isArray(yield* call("GET", "/api/harness"))
        assert.isObject(yield* call("GET", "/api/agent"))

        const opened = (yield* call("POST", "/api/project/open", { directory: repo })) as {
          readonly projectId: string
          readonly directory: string
        }

        assert.strictEqual(opened.directory, repo)

        const launched = (yield* call("POST", "/api/session/launch", {
          projectId: opened.projectId,
          harness: "pi",
          runtime: "herdr",
        })) as { readonly sessionId: string; readonly projectId: string }

        assert.strictEqual(launched.projectId, opened.projectId)

        const got = (yield* call("GET", `/api/session/${launched.sessionId}`)) as { readonly id: string }
        assert.strictEqual(got.id, launched.sessionId)

        const sent = (yield* call("POST", `/api/session/${launched.sessionId}/send`, {
          message: "hello from ui",
        })) as { readonly id: string }

        assert.strictEqual(sent.id, launched.sessionId)

        const second = (yield* call("POST", "/api/session/launch", {
          projectId: opened.projectId,
          harness: "pi",
          runtime: "herdr",
          fresh: true,
        })) as { readonly sessionId: string }

        assert.notStrictEqual(second.sessionId, launched.sessionId)

        const linked = (yield* call("POST", "/api/session/link", {
          spec: Schema.encodeSync(EdgeMutual)(
            EdgeMutual.make({ ids: [{ id: launched.sessionId }, { id: second.sessionId }] }),
          ),
        })) as { readonly edges: ReadonlyArray<unknown> }

        assert.strictEqual(linked.edges.length, 2)

        const unlinked = (yield* call("POST", "/api/session/unlink", {
          spec: Schema.encodeSync(EdgeMutual)(
            EdgeMutual.make({ ids: [{ id: launched.sessionId }, { id: second.sessionId }] }),
          ),
        })) as { readonly edges: ReadonlyArray<unknown> }

        assert.strictEqual(unlinked.edges.length, 2)

        yield* call("POST", `/api/session/${launched.sessionId}/seen`, { finished: 1 })
        yield* call("POST", `/api/session/${second.sessionId}/stop`)
        yield* call("POST", `/api/session/${second.sessionId}/archive`, {})
      }),
    ).pipe(Effect.provide(servedWithUi())),
  )

  it.live("returns Option.none() when disabled via vibest.json", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const ctx = yield* Layer.buildWithScope(testProjectBase(), scope)
      const layout = yield* Effect.provide(Layout, ctx)
      const fsSvc = yield* Effect.provide(FileSystem.FileSystem, ctx)

      yield* fsSvc.writeFileString(layout.config, JSON.stringify({ httpUi: false }))

      const uiScope = yield* Scope.make()
      const uiCtx = yield* Layer.buildWithScope(Ui.layer.pipe(Layer.provide(uiDeps)), uiScope).pipe(Effect.provide(ctx))
      const endpoint = yield* Effect.provide(Ui.Service, uiCtx)

      assert.isTrue(Option.isNone(endpoint))
      yield* Scope.close(uiScope, Exit.void)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live("returns Option.none() when disabled via VIBEST_HTTP_UI=0 or VIBEST_WEBSOCKET=0", () =>
    Effect.gen(function* () {
      for (const env of [{ VIBEST_HTTP_UI: "0" }, { VIBEST_WEBSOCKET: "0" }]) {
        const scope = yield* Scope.make()
        const ctx = yield* Layer.buildWithScope(testProjectBase(), scope)
        const uiScope = yield* Scope.make()

        const uiCtx = yield* Layer.buildWithScope(
          Ui.layer.pipe(Layer.provide(uiDeps), Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))),
          uiScope,
        ).pipe(Effect.provide(ctx))

        const endpoint = yield* Effect.provide(Ui.Service, uiCtx)
        assert.isTrue(Option.isNone(endpoint))
        yield* Scope.close(uiScope, Exit.void)
        yield* Scope.close(scope, Exit.void)
      }
    }),
  )
})
